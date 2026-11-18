// SMART CLICK — push notifications (Firebase Cloud Messaging).
// Deploy: firebase deploy --only functions
const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'me-central1', maxInstances: 3 });

// 🤖 Claude connector (MCP). URL: https://me-central1-<project>.cloudfunctions.net/mcp/<KEY>
const { onRequest } = require('firebase-functions/v2/https');
exports.mcp = onRequest({ invoker: 'public', timeoutSeconds: 60, memory: '256MiB' }, (req, res) => require('./mcp').mcpHandler(req, res));

const TZ = 'Asia/Muscat';
const APP_URL = ''; // links are resolved by the service worker relative to the app's own address
const PREFIX = { sales: 'INV', quotes: 'QT', purchases: 'PUR', payments_in: 'RV', payments_out: 'PV' };

const num = v => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(x) ? x : 0; };
const fmt = n => (Math.round(num(n) * 1000) / 1000).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const pad = (n, w = 5) => String(n ?? '').padStart(w, '0');
// Muscat is UTC+4 all year (no DST)
const muscat = (ms = Date.now()) => new Date(ms + 4 * 3600e3).toISOString(); // "YYYY-MM-DDTHH:MM..."
const todayM = () => muscat().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function settings() { const s = await db.doc('meta/settings').get(); return s.exists ? s.data() : {}; }
async function adminUids() {
  const set = new Set();
  const o = await db.doc('meta/owner').get(); if (o.exists && o.data().uid) set.add(o.data().uid);
  const st = await db.collection('staff').get(); st.forEach(d => { if ((d.data() || {}).role === 'admin') set.add(d.id); });
  return set;
}
// cat: pay | doc | appt | daily. opts: {exclude: uid, only: Set(uids), adminOnly: bool}
async function send(cat, title, body, opts = {}) {
  const snap = await db.collection('pushTokens').get();
  const admins = opts.adminOnly ? await adminUids() : null;
  const targets = [];
  snap.forEach(d => {
    const t = d.data() || {};
    if (!t.token || !(t.prefs || {})[cat]) return;
    if (opts.exclude && t.uid === opts.exclude) return;
    if (opts.only && !opts.only.has(t.uid)) return;
    if (admins && !admins.has(t.uid)) return;
    targets.push({ id: d.id, token: t.token });
  });
  if (!targets.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: targets.map(t => t.token),
    data: { title, body, url: opts.url || './', tag: opts.tag || cat },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
  });
  // remove dead tokens
  const dead = [];
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') dead.push(targets[i].id);
  });
  await Promise.all(dead.map(id => db.collection('pushTokens').doc(id).delete().catch(() => {})));
  return res.successCount;
}

// 💵 new customer receipt
exports.onPayment = onDocumentCreated('payments/{id}', async e => {
  const p = e.data && e.data.data(); if (!p || p.type !== 'in' || p.partyType !== 'customer') return;
  const s = await settings(); const cur = s.currency || 'ر.ع.';
  await send('pay', `💵 دفعة جديدة: ${fmt(p.amount)} ${cur}`,
    `${p.partyName || 'عميل'} · RV-${pad(p.no)}${p.invoiceNo ? ' · عن ' + p.invoiceNo : ''}`,
    { exclude: p.createdBy, adminOnly: true, url: APP_URL + '#receipts', tag: 'pay-' + e.params.id });
});

// 🧾 new invoice / quotation
async function docCreated(kind, e) {
  const d = e.data && e.data.data(); if (!d) return;
  const s = await settings(); const cur = s.currency || 'ر.ع.';
  const label = kind === 'sales' ? '🧾 فاتورة جديدة' : '📝 عرض سعر جديد';
  await send('doc', `${label}: ${PREFIX[kind]}-${pad(d.no)}`, `${d.partyName || ''} · ${fmt(d.total)} ${cur}`,
    { exclude: d.createdBy, adminOnly: true, url: APP_URL + '#' + kind, tag: kind + '-' + e.params.id });
}
exports.onSale = onDocumentCreated('sales/{id}', e => docCreated('sales', e));
exports.onQuote = onDocumentCreated('quotes/{id}', e => docCreated('quotes', e));

// 🔔 test notification requested from the app (Settings → Notifications)
exports.onNotifyTest = onDocumentCreated('notify/{id}', async e => {
  const d = e.data && e.data.data(); if (!d || !d.uid) return;
  const snap = await db.collection('pushTokens').where('uid', '==', d.uid).get();
  const tokens = snap.docs.map(x => x.data().token).filter(Boolean);
  if (tokens.length) await admin.messaging().sendEachForMulticast({ tokens, data: { title: '🔔 إشعار تجريبي', body: 'الإشعارات تعمل على هذا الجهاز ✓', url: './', tag: 'test' }, webpush: { headers: { Urgency: 'high' } } });
  await e.data.ref.delete().catch(() => {});
});

// 📅 appointment / work-order reminders, one hour before (checked every 15 minutes)
exports.apptReminders = onSchedule({ schedule: 'every 15 minutes', timeZone: TZ }, async () => {
  const now = muscat(); const day = now.slice(0, 10); const nowMin = +now.slice(11, 13) * 60 + +now.slice(14, 16);
  const due = (time) => { if (!/^\d{2}:\d{2}$/.test(time || '')) return false; const m = +time.slice(0, 2) * 60 + +time.slice(3, 5); return m - nowMin > 0 && m - nowMin <= 75; };
  const [ap, wo] = await Promise.all([db.collection('appointments').where('date', '==', day).get(), db.collection('workorders').where('due', '==', day).get()]);
  for (const d of ap.docs) {
    const a = d.data(); if (a.remind1h || ['done', 'cancelled'].includes(a.status) || !due(a.time)) continue;
    await send('appt', `📅 موعد الساعة ${a.time}: ${a.customerName || ''}`, [a.location, a.notes].filter(Boolean).join(' · ').slice(0, 140) || 'بعد ساعة تقريباً',
      { only: a.assignedTo ? new Set([a.assignedTo]) : null, url: APP_URL + '#appointments', tag: 'ap-' + d.id });
    await d.ref.update({ remind1h: true });
  }
  for (const d of wo.docs) {
    const w = d.data(); if (w.remind1h || !['new', 'scheduled', 'progress'].includes(w.status || 'new') || !due(w.time)) continue;
    await send('appt', `🛠️ أمر عمل الساعة ${w.time}: ${w.partyName || ''}`, [w.ref, w.location].filter(Boolean).join(' · ').slice(0, 140) || `WO-${pad(w.no)}`,
      { only: (w.techs || []).length ? new Set(w.techs) : null, url: APP_URL + '#workorders', tag: 'wo-' + d.id });
    await d.ref.update({ remind1h: true });
  }
});

// 📅 evening summary of tomorrow's schedule (8 pm Muscat)
exports.tomorrowSummary = onSchedule({ schedule: '0 20 * * *', timeZone: TZ }, async () => {
  const tm = addDays(todayM(), 1);
  const [ap, wo] = await Promise.all([db.collection('appointments').where('date', '==', tm).get(), db.collection('workorders').where('due', '==', tm).get()]);
  const items = [
    ...ap.docs.map(d => d.data()).filter(a => !['done', 'cancelled'].includes(a.status)).map(a => ({ t: a.time || '', s: `${a.time || '—'} ${a.customerName || ''}` })),
    ...wo.docs.map(d => d.data()).filter(w => ['new', 'scheduled', 'progress'].includes(w.status || 'new')).map(w => ({ t: w.time || '', s: `${w.time || '—'} 🛠️ ${w.partyName || ''}` })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  if (!items.length) return;
  await send('appt', `📅 مواعيد الغد: ${items.length}`, items.slice(0, 5).map(x => x.s).join('\n') + (items.length > 5 ? `\n+${items.length - 5}` : ''), { url: APP_URL + '#appointments', tag: 'tomorrow' });
});

// ⚠️ morning alerts: overdue invoices, out-of-stock items, late purchase orders (8 am Muscat)
exports.dailyAlerts = onSchedule({ schedule: '0 8 * * *', timeZone: TZ }, async () => {
  const s = await settings(); const cur = s.currency || 'ر.ع.'; const t = todayM(); const yd = addDays(t, -1);
  const get = c => db.collection(c).get().then(q => q.docs.map(d => ({ id: d.id, ...d.data() })));
  const [sales, pays, sret, pret, prods, purch, wos, pos] = await Promise.all(['sales', 'payments', 'sreturns', 'preturns', 'products', 'purchases', 'workorders', 'porders'].map(c => get(c).catch(() => [])));
  // invoice settlement (payments + credited returns − refunds)
  const paid = new Map(); const add = (k, v) => k && paid.set(k, (paid.get(k) || 0) + v);
  const retById = new Map(sret.map(r => [r.id, r]));
  sret.forEach(r => add(r.invoiceId, num(r.total)));
  pays.forEach(p => { if (p.type === 'tr') return; add(p.invoiceId, num(p.amount)); if (p.returnId) { const r = retById.get(p.returnId); if (r) add(r.invoiceId, -num(p.amount)); } });
  const od = num(s.overdueDays) || 30;
  let late = 0, lateAmt = 0, newLate = 0;
  sales.forEach(x => { const rem = num(x.total) - (paid.get(x.id) || 0); if (rem <= 0.0005) return; const ed = x.due || (x.date ? addDays(x.date, od) : ''); if (ed && ed < t) { late++; lateAmt += rem; if (ed === yd) newLate++; } });
  // stock
  const st = new Map(prods.map(p => [p.id, num(p.opening)]));
  const mv = (lines, sign, skip) => (lines || []).forEach(l => { if (l.productId && st.has(l.productId) && !(skip && l.noStock)) st.set(l.productId, st.get(l.productId) + sign * num(l.qty)); });
  purch.forEach(d => mv(d.lines, 1)); sales.forEach(d => mv(d.lines, -1, true)); sret.forEach(d => mv(d.lines, 1)); pret.forEach(d => mv(d.lines, -1));
  wos.forEach(d => { if (d.status === 'done' || d.status === 'invoiced') mv(d.lines, -1); });
  const out = prods.filter(p => !p.service && num(p.minQty) > 0 && (st.get(p.id) || 0) <= 0);
  const low = prods.filter(p => !p.service && num(p.minQty) > 0 && (st.get(p.id) || 0) > 0 && (st.get(p.id) || 0) <= num(p.minQty));
  const latePO = pos.filter(p => !['received', 'cancelled'].includes(p.status) && p.due && p.due < t);
  const lines = [];
  if (late) lines.push(`🧾 ${late} فاتورة متأخرة بمبلغ ${fmt(lateAmt)} ${cur}${newLate ? ` (${newLate} جديدة اليوم)` : ''}`);
  if (out.length) lines.push(`📦 نفد: ${out.slice(0, 3).map(p => p.name).join('، ')}${out.length > 3 ? ` +${out.length - 3}` : ''}`);
  if (low.length) lines.push(`📉 تحت الحد الأدنى: ${low.length} صنف`);
  if (latePO.length) lines.push(`📋 ${latePO.length} أمر شراء متأخر التوريد`);
  if (!lines.length) return;
  await send('daily', '⚠️ تنبيهات اليوم', lines.join('\n'), { adminOnly: true, url: './', tag: 'daily' });
});
