// 🖼️ Copy product photos from Daftra into the app (admin only, callable).
// The Daftra API key is sent with each call and is never stored.
// Photos are saved exactly like the in-app cropper: products.img = 128px JPEG thumb, pimages/{id}.data = 640px JPEG.
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');

const db = () => admin.firestore();
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;

async function daftra(sub, key, path) {
  const r = await fetch(`https://${sub}.daftra.com/api2/${path}`, { headers: { apikey: key, Accept: 'application/json' } });
  const t = await r.text();
  if (r.status === 401 || r.status === 403) throw new HttpsError('permission-denied', 'مفتاح دفترة غير صحيح أو بدون صلاحية الأصناف');
  if (!r.ok) throw new HttpsError('internal', `Daftra ${r.status}: ${t.slice(0, 200)}`);
  try { return JSON.parse(t); } catch (_) { throw new HttpsError('internal', 'Daftra returned non-JSON: ' + t.slice(0, 200)); }
}

// collect every image-looking string inside a value; default images first
function findImages(v, sub, out = [], isDefault = false) {
  if (v == null) return out;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^https?:\/\//i.test(s) && (IMG_RE.test(s) || /\/product\//i.test(s))) out.push({ url: s, def: isDefault });
    else if (/^\/?files\//i.test(s) && IMG_RE.test(s)) out.push({ url: `https://${sub}.daftra.com/${s.replace(/^\//, '')}`, def: isDefault });
    return out;
  }
  if (Array.isArray(v)) { v.forEach(x => findImages(x, sub, out, isDefault)); return out; }
  if (typeof v === 'object') {
    const def = isDefault || ['default', 'is_default', 'default_image', 'main'].some(k => String(v[k]) === '1' || v[k] === true);
    for (const k of Object.keys(v)) findImages(v[k], sub, out, def);
  }
  return out;
}
const pickImage = (item, sub) => {
  const fromImgs = findImages(item.ProductImage || item.product_images || item.images || [], sub);
  const all = fromImgs.length ? fromImgs : findImages(item, sub);
  const uniq = [...new Map(all.map(x => [x.url, x])).values()];
  return (uniq.find(x => x.def) || uniq[0] || {}).url || '';
};

async function toDataUrls(url) {
  const sharp = require('sharp');
  const r = await fetch(url);
  if (!r.ok) throw new Error('download ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const base = sharp(buf, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' });
  const mk = async (size, q) => 'data:image/jpeg;base64,' + (await base.clone()
    .resize(size, size, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: q }).toBuffer()).toString('base64');
  let full = await mk(640, 84); if (full.length > 500000) full = await mk(640, 70);
  return { full, thumb: await mk(128, 80) };
}

async function appProducts() {
  const snap = await db().collection('products').get();
  const byName = new Map(), byCode = new Map();
  snap.forEach(d => {
    const p = { id: d.id, ...d.data() };
    if (p.name) byName.set(norm(p.name), p);
    if (p.nameEn) byName.set(norm(p.nameEn), p);
    if (p.code) byCode.set(norm(p.code), p);
    if (p.barcode) byCode.set(norm(p.barcode), p);
  });
  return { byName, byCode };
}
const match = (P, dp) => P.byName.get(norm(dp.name)) || (dp.product_code && P.byCode.get(norm(dp.product_code))) || (dp.barcode && P.byCode.get(norm(dp.barcode))) || null;

async function handleOne(item, sub, P, overwrite, by) {
  const dp = item.Product || item;
  const res = { daftraId: dp.id, name: String(dp.name || '').trim() };
  const app = match(P, dp);
  if (!app) return { ...res, status: 'no-match' };
  res.appName = app.name;
  if (app.img && !overwrite) return { ...res, status: 'has-image' };
  const url = pickImage(item, sub);
  if (!url) return { ...res, status: 'no-image' };
  try {
    const { full, thumb } = await toDataUrls(url);
    const now = new Date().toISOString();
    await db().collection('products').doc(app.id).update({ img: thumb, updatedAt: now });
    await db().doc('pimages/' + app.id).set({ data: full, updatedAt: now, from: 'daftra' });
    app.img = thumb;
    return { ...res, status: 'saved' };
  } catch (e) { return { ...res, status: 'error', error: String(e.message || e).slice(0, 120) }; }
}

// data: {key, sub?, page?, test?: daftraProductId, overwrite?}
async function run(data, uid, email) {
  const key = String(data.key || '').trim(); if (key.length < 10) throw new HttpsError('invalid-argument', 'أدخل مفتاح API من دفترة');
  const sub = String(data.sub || 'smartttouchom').replace(/[^a-z0-9-]/gi, '');
  const overwrite = !!data.overwrite;
  const P = await appProducts();

  if (data.test) {
    const j = await daftra(sub, key, `products/${parseInt(data.test, 10)}.json`);
    const item = j.data || j;
    const raw = JSON.stringify(item.ProductImage ?? item.product_images ?? null).slice(0, 1500);
    const r = await handleOne(item, sub, P, true, uid);
    return { test: true, result: r, imageUrl: pickImage(item, sub).slice(0, 300), raw };
  }

  const page = Math.max(1, parseInt(data.page, 10) || 1);
  const j = await daftra(sub, key, `products.json?page=${page}&limit=20`);
  const list = Array.isArray(j.data) ? j.data : [];
  const pageCount = (j.pagination && (j.pagination.page_count || j.pagination.pageCount)) || (list.length < 20 ? page : page + 1);
  const results = [];
  for (const it of list) {
    let item = it;
    const dp = it.Product || it;
    // the list may not carry images; fetch the single product only when we will use it
    if (!pickImage(it, sub)) {
      const app = match(P, dp);
      if (app && (!app.img || overwrite)) { try { const s = await daftra(sub, key, `products/${dp.id}.json`); item = s.data || s; } catch (_) {} }
    }
    results.push(await handleOne(item, sub, P, overwrite, uid));
  }
  if (page === 1) await db().collection('activity').add({ at: new Date().toISOString(), by: uid, byEmail: email || '', action: 'import', col: 'pimages', docId: '', label: 'نقل صور الأصناف من دفترة', changes: [] }).catch(() => {});
  return { page, pageCount, done: page >= pageCount || !list.length, results };
}

module.exports = { run, _t: { pickImage, toDataUrls } };
