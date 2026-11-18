// SMART CLICK — MCP connector for Claude (Streamable HTTP, stateless JSON responses).
// URL: https://me-central1-<project>.cloudfunctions.net/mcp/<KEY>   (KEY is generated in the app: Settings → Claude connector)
const admin = require('firebase-admin');
const crypto = require('crypto');
const db = admin.firestore();

/* ---------------- helpers (mirror the web app's maths) ---------------- */
const num = v => { const x = parseFloat(String(v ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/,/g, '')); return isFinite(x) ? x : 0; };
const r3 = n => Math.round((+n || 0) * 1000) / 1000;
const fmt = n => r3(n).toFixed(3);
const norm = s => String(s ?? '').trim().toLowerCase();
const nowIso = () => new Date().toISOString();
const todayM = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10); // Asia/Muscat
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const KIND = {
  quotes: { prefix: 'QT', party: 'customers', ar: 'عرض سعر' },
  sales: { prefix: 'INV', party: 'customers', ar: 'فاتورة مبيعات' },
  purchases: { prefix: 'PUR', party: 'suppliers', ar: 'فاتورة مشتريات' },
  porders: { prefix: 'PO', party: 'suppliers', ar: 'أمر شراء' },
  sreturns: { prefix: 'SR', party: 'customers', ar: 'مرتجع مبيعات' },
  preturns: { prefix: 'PR', party: 'suppliers', ar: 'مرتجع مشتريات' },
};
const EDITABLE = ['quotes', 'sales', 'purchases', 'porders'];
const docNo = (k, no) => KIND[k].prefix + '-' + String(no || 0).padStart(5, '0');
const lineTotal = l => { const g = num(l.qty) * num(l.price); return r3(l.discType === 'a' ? g - num(l.disc) : g - g * num(l.disc) / 100); };
function calc(d) {
  let sub = 0, vb = 0; for (const l of d.lines) { l.total = lineTotal(l); sub += l.total; if (!l.noVat) vb += l.total; }
  sub = r3(sub); vb = r3(vb); const discount = d.discType === 'p' ? r3(sub * num(d.discPct) / 100) : r3(num(d.discount));
  const taxable = r3(sub - discount);
  const vatBase = d.vatOn ? (vb === sub ? taxable : r3(vb - (sub > 0 ? discount * vb / sub : 0))) : 0;
  const vat = d.vatOn ? r3(vatBase * num(d.vatRate) / 100) : 0;
  return { sub, discount, vatBase, vat, total: r3(taxable + vat) };
}
const all = async c => (await db.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const settings = async () => { const s = await db.doc('meta/settings').get(); return s.exists ? s.data() : {}; };
function findParty(list, q) {
  const k = norm(q); if (!k) return null;
  return list.find(x => x.id === q) || list.find(x => norm(x.name) === k) || list.find(x => x.nameEn && norm(x.nameEn) === k) || null;
}
function fuzzy(list, q, fields) {
  const k = norm(q); if (!k) return list;
  const words = k.split(/\s+/).filter(Boolean);
  return list.filter(x => { const hay = fields.map(f => norm(x[f])).join(' '); return words.every(w => hay.includes(w)); });
}
function findProduct(prods, key) {
  const k = norm(key); if (!k) return null;
  return prods.find(p => p.id === key) || prods.find(p => p.code && norm(p.code) === k) || prods.find(p => norm(p.name) === k) || prods.find(p => p.nameEn && norm(p.nameEn) === k) || null;
}
function parseNo(kind, ref) {
  const s = String(ref ?? '').trim().toUpperCase();
  const m = s.match(/(\d+)\s*$/); if (!m) return null;
  return docNo(kind, parseInt(m[1], 10));
}
async function getDocByRef(kind, ref) {
  const byId = await db.collection(kind).doc(String(ref)).get();
  if (byId.exists) return { id: byId.id, ...byId.data() };
  const id = parseNo(kind, ref); if (!id) return null;
  const g = await db.collection(kind).doc(id).get();
  if (g.exists) return { id: g.id, ...g.data() };
  const n = parseInt(String(ref).match(/(\d+)\s*$/)[1], 10);
  const q = await db.collection(kind).where('no', '==', n).limit(1).get();
  return q.empty ? null : { id: q.docs[0].id, ...q.docs[0].data() };
}
async function nextRef(col, prefix, filter) {
  const list = await all(col); let max = 0;
  for (const x of list) if (!filter || filter(x)) max = Math.max(max, num(x.no));
  return { start: max + 1, prefix };
}
// create with a unique sequential id (ref.create fails if the id is taken)
async function createNumbered(col, prefix, body, filter, exact) {
  if (exact) {
    const id = prefix + '-' + String(exact).padStart(5, '0');
    try { await db.collection(col).doc(id).create({ ...body, no: exact }); return { id, no: exact }; }
    catch (e) { if (e.code === 6 || /already exists/i.test(e.message)) throw new Error(`Number ${id} already exists in the app.`); throw e; }
  }
  const s = await settings(); const ns = s.numStart || {};
  let { start } = await nextRef(col, prefix, filter);
  start = Math.max(start, Math.floor(num(ns[col === 'payments' ? prefix : col])) || 1);
  for (let i = 0; i < 30; i++, start++) {
    const id = prefix + '-' + String(start).padStart(5, '0');
    try { await db.collection(col).doc(id).create({ ...body, no: start }); return { id, no: start }; }
    catch (e) { if (e.code === 6 || /already exists/i.test(e.message)) continue; throw e; }
  }
  throw new Error('numbering failed');
}
async function log(action, col, docId, label) {
  await db.collection('activity').add({ at: nowIso(), by: 'claude', byEmail: 'claude', action, col, docId: docId || '', label: String(label || '').slice(0, 200), changes: [] }).catch(() => {});
}
async function derive() {
  const [sales, purchases, pays, sret, pret, prods, wos, custs, sups] = await Promise.all(['sales', 'purchases', 'payments', 'sreturns', 'preturns', 'products', 'workorders', 'customers', 'suppliers'].map(c => all(c).catch(() => [])));
  const paid = new Map(), cash = new Map(); const add = (m, k, v) => k && m.set(k, (m.get(k) || 0) + v);
  const retById = new Map([...sret, ...pret].map(r => [r.id, r]));
  [...sret, ...pret].forEach(r => add(paid, r.invoiceId, num(r.total)));
  pays.forEach(p => { if (p.type === 'tr') return; add(paid, p.invoiceId, num(p.amount)); add(cash, p.invoiceId, num(p.amount)); if (p.returnId) { const r = retById.get(p.returnId); if (r) { add(paid, r.invoiceId, -num(p.amount)); add(cash, r.invoiceId, -num(p.amount)); } } });
  const st = new Map(prods.map(p => [p.id, num(p.opening)]));
  const mv = (lines, sign, skip) => (lines || []).forEach(l => { if (l.productId && st.has(l.productId) && !(skip && l.noStock)) st.set(l.productId, st.get(l.productId) + sign * num(l.qty)); });
  purchases.forEach(d => mv(d.lines, 1, true)); sales.forEach(d => mv(d.lines, -1, true)); sret.forEach(d => mv(d.lines, 1)); pret.forEach(d => mv(d.lines, -1));
  wos.forEach(d => { if (d.status === 'done' || d.status === 'invoiced') mv(d.lines, -1); });
  const cust = new Map(custs.map(c => [c.id, num(c.opening)])), sup = new Map(sups.map(c => [c.id, num(c.opening)]));
  sales.forEach(d => d.partyId && cust.has(d.partyId) && cust.set(d.partyId, cust.get(d.partyId) + num(d.total)));
  purchases.forEach(d => d.partyId && sup.has(d.partyId) && sup.set(d.partyId, sup.get(d.partyId) + num(d.total)));
  sret.forEach(d => d.partyId && cust.has(d.partyId) && cust.set(d.partyId, cust.get(d.partyId) - num(d.total)));
  pret.forEach(d => d.partyId && sup.has(d.partyId) && sup.set(d.partyId, sup.get(d.partyId) - num(d.total)));
  pays.forEach(p => { const a = num(p.amount); if (p.partyType === 'customer' && cust.has(p.partyId)) cust.set(p.partyId, cust.get(p.partyId) + (p.type === 'in' ? -a : a)); if (p.partyType === 'supplier' && sup.has(p.partyId)) sup.set(p.partyId, sup.get(p.partyId) + (p.type === 'out' ? -a : a)); });
  return { sales, purchases, pays, sret, pret, prods, custs, sups, paid, cash, stock: st, cust, sup };
}
function effDue(x, s) { return x.due || (x.date ? addDays(x.date, num(s.overdueDays) || 30) : ''); }
function status(kind, d, D, s) {
  if (kind === 'quotes') return d.status === 'converted' ? 'converted to invoice' : d.status === 'rejected' ? 'rejected' : (d.due && d.due < todayM() ? 'expired' : 'open');
  if (kind === 'porders') return d.status === 'received' ? 'received' : d.status === 'cancelled' ? 'cancelled' : (d.due && d.due < todayM() ? 'delivery overdue' : 'open');
  if (kind === 'sreturns' || kind === 'preturns') return 'return';
  const p = D.paid.get(d.id) || 0, t = num(d.total);
  if (t <= 0.0005 || p >= t - 0.0005) return 'paid';
  const ed = kind === 'sales' ? effDue(d, s) : d.due;
  if (ed && ed < todayM()) return p > 0 ? 'overdue (partially paid)' : 'overdue';
  return p > 0 ? 'partially paid' : 'unpaid';
}
const summary = (kind, d, D, s) => ({
  id: d.id, number: docNo(kind, d.no), date: d.date, due: d.due || '', party: d.partyName, total: fmt(d.total), status: status(kind, d, D, s),
  ...(EDITABLE.includes(kind) && kind !== 'quotes' && kind !== 'porders' ? { paid: fmt(D.paid.get(d.id) || 0), remaining: fmt(num(d.total) - (D.paid.get(d.id) || 0)) } : {}),
});
const full = (kind, d, D, s) => ({
  ...summary(kind, d, D, s), ref: d.ref || '', notes: d.notes || '', currency: s.currency || 'OMR',
  lines: (d.lines || []).map(l => ({ product_id: l.productId || null, name: l.name, description: l.desc || '', qty: l.qty, price: fmt(l.price), discount: num(l.disc) ? (l.discType === 'a' ? fmt(l.disc) + ' (amount)' : num(l.disc) + '%') : '', total: fmt(l.total) })),
  subtotal: fmt(d.sub), invoice_discount: fmt(d.discount), vat: fmt(d.vat), vat_rate: d.vatOn ? num(d.vatRate) : 0,
  ...(d.quoteId ? { from_quote: d.quoteId } : {}), ...(d.poId ? { from_purchase_order: d.poId } : {}), ...(d.invoiceId ? { invoice: d.invoiceId } : {}),
});

/* ---------------- building a document from tool input ---------------- */
async function buildDoc(kind, a, old, s, D) {
  const k = KIND[kind]; const warn = [];
  // party
  let party = null, partyName = old ? old.partyName : '';
  const parties = k.party === 'customers' ? D.custs : D.sups;
  if (a.party != null && String(a.party).trim()) {
    party = findParty(parties, a.party);
    if (!party) {
      const cands = fuzzy(parties, a.party, ['name', 'nameEn', 'phone']).slice(0, 5);
      if (!a.create_party_if_missing) return { error: `No ${k.party === 'customers' ? 'customer' : 'supplier'} named "${a.party}".` + (cands.length ? ` Did you mean: ${cands.map(c => c.name).join(' | ')}?` : '') + ' Use the exact name, or pass create_party_if_missing=true (after the user confirms) to create it.' };
      party = { id: null, name: String(a.party).trim(), _new: true };
      warn.push(`A new ${k.party === 'customers' ? 'customer' : 'supplier'} "${party.name}" will be created.`);
    }
    partyName = party.name;
  } else if (old) { party = old.partyId ? parties.find(x => x.id === old.partyId) || { id: old.partyId, name: old.partyName } : null; }
  // lines
  let lines;
  if (Array.isArray(a.lines)) {
    if (!a.lines.length) return { error: 'At least one line is required.' };
    lines = [];
    for (const [i, L] of a.lines.entries()) {
      const key = L.product_id || L.product || L.code || '';
      const p = key ? findProduct(D.prods, key) : null;
      if (key && !p && !L.name) {
        const cands = fuzzy(D.prods, key, ['name', 'nameEn', 'code']).slice(0, 5);
        return { error: `Line ${i + 1}: no product matches "${key}".` + (cands.length ? ` Candidates: ${cands.map(c => `${c.name}${c.code ? ' [' + c.code + ']' : ''} (id ${c.id})`).join(' | ')}.` : '') + ' Use product_id, or give "name" for a free-text line (not tracked in stock).' };
      }
      const qty = num(L.qty ?? 1); if (qty <= 0) return { error: `Line ${i + 1}: qty must be > 0.` };
      const usesCost = k.party === 'suppliers';
      const price = L.price != null && L.price !== '' ? num(L.price) : p ? num(usesCost ? p.cost : p.price) : 0;
      if (price < 0) return { error: `Line ${i + 1}: price cannot be negative.` };
      const dt = /^a/i.test(L.discount_type || '') ? 'a' : 'p'; const disc = num(L.discount || 0);
      if (disc < 0 || (dt === 'p' && disc > 100) || (dt === 'a' && disc > qty * price + 0.0005)) return { error: `Line ${i + 1}: invalid discount.` };
      const line = { productId: p ? p.id : '', name: p ? p.name : String(L.name || key).trim(), nameEn: p ? (p.nameEn || '') : '', qty: r3(qty), price: r3(price), disc: r3(disc), discType: dt };
      if (L.vat === false || (L.vat == null && p && p.noVat)) line.noVat = true;
      const desc = L.description != null ? String(L.description).trim() : (p && p.desc ? String(p.desc).trim() : '');
      if (desc) line.desc = desc;
      if (!line.name) return { error: `Line ${i + 1}: name is required.` };
      if (!p) warn.push(`Line ${i + 1} "${line.name}" is free text (not linked to a stock item).`);
      if (a.migrated_from && p && !p.service) line.noStock = true;
      if (!a.migrated_from && p && kind === 'sales' && !p.service && (D.stock.get(p.id) || 0) < qty) warn.push(`Stock for "${p.name}" is ${D.stock.get(p.id) || 0}, less than ${qty}.`);
      if (!a.migrated_from && p && kind === 'sales' && p.trackSerial) warn.push(`"${p.name}" tracks serial numbers — add them later in the app.`);
      lines.push(line);
    }
  } else if (old) { lines = JSON.parse(JSON.stringify(old.lines || [])); }
  else return { error: 'lines are required.' };
  if (old && old.migrated && Array.isArray(a.lines)) lines.forEach(l => { const p = D.prods.find(x => x.id === l.productId); if (p && !p.service) l.noStock = true; });
  const date = a.date || (old ? old.date : todayM());
  let due = a.due != null ? a.due : old ? old.due : (kind === 'quotes' ? addDays(date, num(s.quoteDays) || 15) : kind === 'sales' && num(s.dueDays) ? addDays(date, num(s.dueDays)) : '');
  const d = {
    lines, vatOn: a.vat != null ? !!a.vat : old ? !!old.vatOn : true, vatRate: old && a.vat == null ? num(old.vatRate) : num(s.vatRate ?? 5),
    discType: a.discount_type ? (/^p/i.test(a.discount_type) ? 'p' : 'a') : old ? (old.discType === 'p' ? 'p' : 'a') : 'a',
  };
  const dv = a.discount != null ? num(a.discount) : old ? (d.discType === 'p' ? num(old.discPct) : num(old.discount)) : 0;
  if (d.discType === 'p') { d.discPct = dv; d.discount = 0; } else { d.discount = dv; d.discPct = 0; }
  const c = calc(d);
  if (c.discount < 0 || c.discount > c.sub + 0.0005 || (d.discType === 'p' && dv > 100)) return { error: 'Invoice discount must be between 0 and the subtotal.' };
  const body = {
    date, due: due || '', partyId: party && party.id ? party.id : '', partyName: partyName || (k.party === 'suppliers' ? 'مورد نقدي' : 'عميل نقدي'),
    ref: a.ref != null ? String(a.ref) : a.migrated_from ? String(a.migrated_from) : old ? old.ref || '' : '',
    ...(a.migrated_from ? { migrated: String(a.migrated_from) } : old && old.migrated ? { migrated: old.migrated } : {}),
    lines: lines.map(l => ({ ...l, total: r3(l.total) })), discount: c.discount, discType: d.discType, discPct: d.discType === 'p' ? d.discPct : 0,
    vatOn: d.vatOn, vatRate: d.vatRate, sub: c.sub, vatBase: c.vatBase, vat: c.vat, total: c.total, notes: a.notes != null ? String(a.notes) : old ? old.notes || '' : '',
    updatedAt: nowIso(), updatedBy: 'claude', portalDirty: k.party === 'customers',
  };
  return { body, party, warn };
}
async function ensureParty(col, party) {
  if (!party || !party._new) return party;
  const ref = db.collection(col).doc();
  const data = { name: party.name, phone: '', opening: 0, createdAt: nowIso(), createdBy: 'claude' };
  await ref.set(data); await log('create', col, ref.id, party.name);
  return { id: ref.id, ...data };
}
function preview(kind, body, warn, extra) {
  return {
    preview: true, kind, note: 'NOT SAVED. Show this to the user and call again with confirm=true only after they approve.', ...extra,
    party: body.partyName, date: body.date, due: body.due,
    lines: body.lines.map(l => `${l.name}${l.desc ? ' — ' + l.desc : ''} × ${l.qty} @ ${fmt(l.price)}${num(l.disc) ? ' − ' + (l.discType === 'a' ? fmt(l.disc) : l.disc + '%') : ''} = ${fmt(l.total)}${l.noVat ? ' (no VAT)' : ''}`),
    subtotal: fmt(body.sub), discount: fmt(body.discount), vat_base: fmt(body.vatBase), vat: fmt(body.vat), total: fmt(body.total), warnings: warn,
  };
}

/* ---------------- tools ---------------- */
const S_KIND_ALL = { type: 'string', enum: Object.keys(KIND), description: 'quotes=عروض أسعار, sales=فواتير مبيعات, purchases=فواتير مشتريات, porders=أوامر شراء, sreturns=مرتجعات مبيعات, preturns=مرتجعات مشتريات' };
const S_KIND_EDIT = { type: 'string', enum: EDITABLE, description: 'quotes, sales, purchases or porders' };
const S_LINES = {
  type: 'array', description: 'Document lines. Prefer product_id from search_products. A line without a matching product needs "name" and is free text.',
  items: { type: 'object', properties: {
    product_id: { type: 'string' }, product: { type: 'string', description: 'Product name or code (exact) if no id' }, name: { type: 'string', description: 'Free-text line name' },
    description: { type: 'string', description: 'Line description/notes (defaults to the product description)' },
    qty: { type: 'number' }, price: { type: 'number', description: 'Unit price before VAT. Defaults to the product sale price (cost for suppliers).' },
    discount: { type: 'number', description: 'Line discount. With discount_type=amount this is the TOTAL discount for the whole line (not per unit).' }, discount_type: { type: 'string', enum: ['percent', 'amount'] },
    vat: { type: 'boolean', description: 'false = this line has no VAT (exempt / out of scope). Defaults to the product setting.' },
  }, required: ['qty'] },
};
const S_DOC_FIELDS = {
  party: { type: 'string', description: 'Exact customer/supplier name (or id)' },
  create_party_if_missing: { type: 'boolean', description: 'Create the party if not found (ask the user first)' },
  date: { type: 'string', description: 'YYYY-MM-DD (default today)' }, due: { type: 'string', description: 'YYYY-MM-DD; quotes: valid until; porders: expected delivery' },
  lines: S_LINES, discount: { type: 'number', description: 'Overall discount' }, discount_type: { type: 'string', enum: ['amount', 'percent'] },
  vat: { type: 'boolean', description: 'Apply VAT (default true, rate from settings)' },
  keep_number: { type: 'number', description: 'Only with migrated_from: save under the old system\'s number (e.g. 798 → INV-00798). Fails if that number is already used.' },
  migrated_from: { type: 'string', description: 'For documents moved from the old system (e.g. "دفترة 000798"): stored as the reference and the lines do NOT change stock (stock was already counted).' }, notes: { type: 'string' }, ref: { type: 'string', description: 'Reference / customer PO number' },
  confirm: { type: 'boolean', description: 'false/omitted = preview only. true = save (only after the user approved the preview).' },
};
const TOOLS = [
  { name: 'search_customers', description: 'Find customers by name, phone or English name. Returns id, name, phone, email and current balance (positive = they owe us).', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'search_suppliers', description: 'Find suppliers. Returns id, name, phone and balance (positive = we owe them).', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'search_products', description: 'Find products/services by name, English name or code. Returns id, code, sale price, cost, stock and description.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'list_documents', description: 'List documents of a kind, newest first, optionally filtered by party name text and status.', inputSchema: { type: 'object', properties: { kind: S_KIND_ALL, party: { type: 'string' }, status: { type: 'string', enum: ['open', 'unpaid', 'overdue', 'paid', 'converted', 'received', 'cancelled', 'rejected'] }, limit: { type: 'number' } }, required: ['kind'] } },
  { name: 'get_document', description: 'Get one document with all lines and totals. number like "QT-00012", "INV-7" or just 12.', inputSchema: { type: 'object', properties: { kind: S_KIND_ALL, number: { type: 'string' } }, required: ['kind', 'number'] } },
  { name: 'create_document', description: 'Create a quotation, sales invoice, purchase invoice or purchase order. ALWAYS call first without confirm to get a preview, show it to the user, then call again with confirm=true after explicit approval.', inputSchema: { type: 'object', properties: { kind: S_KIND_EDIT, ...S_DOC_FIELDS }, required: ['kind', 'lines'] } },
  { name: 'update_document', description: 'Edit a quotation/invoice/purchase order. Only the given fields change; "lines" replaces ALL lines. Preview first, then confirm=true after approval.', inputSchema: { type: 'object', properties: { kind: S_KIND_EDIT, number: { type: 'string' }, ...S_DOC_FIELDS }, required: ['kind', 'number'] } },
  { name: 'delete_document', description: 'Delete a document permanently. Blocked if payments or returns are linked. Requires confirm=true after the user explicitly approves.', inputSchema: { type: 'object', properties: { kind: S_KIND_ALL, number: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['kind', 'number'] } },
  { name: 'convert_quote_to_invoice', description: 'Create a sales invoice from a quotation (same lines and discounts) and mark the quote as converted. Requires confirm=true after approval.', inputSchema: { type: 'object', properties: { number: { type: 'string' }, date: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['number'] } },
  { name: 'convert_po_to_purchase', description: 'Receive a purchase order: create a purchase invoice from it (adds stock) and mark the PO as received. Requires confirm=true after approval.', inputSchema: { type: 'object', properties: { number: { type: 'string' }, date: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['number'] } },
  { name: 'set_status', description: 'Change status: quotes → open|rejected; porders → open|cancelled. Requires confirm=true.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['quotes', 'porders'] }, number: { type: 'string' }, status: { type: 'string', enum: ['open', 'rejected', 'cancelled'] }, confirm: { type: 'boolean' } }, required: ['kind', 'number', 'status'] } },
  { name: 'record_payment', description: 'Record a customer receipt against a sales invoice, or a supplier payment against a purchase invoice. Requires confirm=true after approval.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['sales', 'purchases'] }, number: { type: 'string' }, amount: { type: 'number' }, method: { type: 'string', enum: ['cash', 'bank', 'card', 'cheque'] }, date: { type: 'string' }, notes: { type: 'string' }, migrated_from: { type: 'string', description: 'For an old payment from the previous system (e.g. "دفترة 000798"): it settles the invoice and customer balance but does NOT enter the cash box / bank balance.' }, confirm: { type: 'boolean' } }, required: ['kind', 'number', 'amount'] } },
  { name: 'mark_payment_migrated', description: 'Mark an existing voucher (e.g. RV-00001) as an old payment moved from the previous system, so it no longer counts in the cash box / bank balance. Requires confirm=true.', inputSchema: { type: 'object', properties: { voucher: { type: 'string' }, migrated_from: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['voucher'] } },
  { name: 'create_party', description: 'Create a customer or supplier. Requires confirm=true after approval.', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['customer', 'supplier'] }, name: { type: 'string' }, name_en: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, vat_no: { type: 'string' }, address: { type: 'string' }, city: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['type', 'name'] } },
  { name: 'get_party_statement', description: 'Balance and open (unpaid) invoices of a customer or supplier.', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['customer', 'supplier'] }, party: { type: 'string' } }, required: ['type', 'party'] } },
  { name: 'list_overdue_invoices', description: 'Unpaid sales invoices past their due date, oldest first, with remaining amounts.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
];

const RO_T = ['search_customers', 'search_suppliers', 'search_products', 'list_documents', 'get_document', 'get_party_statement', 'list_overdue_invoices'];
TOOLS.forEach(t => { t.annotations = RO_T.includes(t.name) ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: t.name === 'delete_document' || t.name === 'update_document' }; });
const ok = o => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] });
const fail = m => ({ content: [{ type: 'text', text: m }], isError: true });

async function callTool(name, a) {
  a = a || {};
  const s = await settings();
  const D = await derive();
  const lim = n => Math.max(1, Math.min(100, num(n) || 20));
  switch (name) {
    case 'search_customers': case 'search_suppliers': {
      const isC = name === 'search_customers'; const list = isC ? D.custs : D.sups; const bal = isC ? D.cust : D.sup;
      return ok(fuzzy(list, a.query || '', ['name', 'nameEn', 'phone', 'email']).slice(0, lim(a.limit)).map(x => ({ id: x.id, name: x.name, name_en: x.nameEn || '', phone: x.phone || '', email: x.email || '', vat_no: x.vatNo || '', balance: fmt(bal.get(x.id) || 0) })));
    }
    case 'search_products':
      return ok(fuzzy(D.prods, a.query || '', ['name', 'nameEn', 'code', 'category']).slice(0, lim(a.limit)).map(p => ({ id: p.id, name: p.name, name_en: p.nameEn || '', code: p.code || '', price: fmt(p.price), cost: fmt(p.cost), unit: p.unit || '', stock: p.service ? 'service' : r3(D.stock.get(p.id) || 0), description: p.desc || '' })));
    case 'list_documents': {
      if (!KIND[a.kind]) return fail('Unknown kind.');
      let list = await all(a.kind);
      if (a.party) { const k = norm(a.party); list = list.filter(x => norm(x.partyName).includes(k)); }
      let out = list.sort((x, y) => ((y.date || '') + String(y.no).padStart(8, '0')).localeCompare((x.date || '') + String(x.no).padStart(8, '0'))).map(x => summary(a.kind, x, D, s));
      if (a.status) out = out.filter(x => a.status === 'unpaid' ? !/^paid/.test(x.status) && x.status !== 'return' : x.status.startsWith(a.status === 'converted' ? 'converted' : a.status));
      return ok(out.slice(0, lim(a.limit)));
    }
    case 'get_document': {
      if (!KIND[a.kind]) return fail('Unknown kind.');
      const d = await getDocByRef(a.kind, a.number); if (!d) return fail('Document not found.');
      const pays = D.pays.filter(p => p.invoiceId === d.id).map(p => ({ number: (p.type === 'in' ? 'RV-' : 'PV-') + String(p.no).padStart(5, '0'), date: p.date, amount: fmt(p.amount), method: p.method }));
      return ok({ ...full(a.kind, d, D, s), payments: pays });
    }
    case 'create_document': {
      if (!EDITABLE.includes(a.kind)) return fail('kind must be quotes, sales, purchases or porders.');
      const r = await buildDoc(a.kind, a, null, s, D); if (r.error) return fail(r.error);
      if (!a.confirm) return ok(preview(a.kind, r.body, r.warn, { action: 'create ' + KIND[a.kind].ar }));
      const party = await ensureParty(KIND[a.kind].party, r.party);
      const body = { ...r.body, partyId: party && party.id ? party.id : '', partyName: party ? party.name : r.body.partyName, createdAt: nowIso(), createdBy: 'claude', status: 'open', quoteId: '', invoiceId: '' };
      const exact = a.migrated_from && num(a.keep_number) > 0 ? Math.floor(num(a.keep_number)) : 0;
      const { id, no } = await createNumbered(a.kind, KIND[a.kind].prefix, body, null, exact);
      await log('create', a.kind, id, `${docNo(a.kind, no)} · ${body.partyName}`);
      return ok({ saved: true, number: docNo(a.kind, no), id, total: fmt(body.total), warnings: r.warn });
    }
    case 'update_document': {
      if (!EDITABLE.includes(a.kind)) return fail('kind must be quotes, sales, purchases or porders.');
      const old = await getDocByRef(a.kind, a.number); if (!old) return fail('Document not found.');
      if (a.kind === 'quotes' && old.status === 'converted') return fail('This quote was already converted to an invoice; edit the invoice instead.');
      const r = await buildDoc(a.kind, a, old, s, D); if (r.error) return fail(r.error);
      if (a.kind === 'sales' || a.kind === 'purchases') { const paid = D.paid.get(old.id) || 0; if (paid > r.body.total + 0.0005) r.warn.push(`Already paid/credited ${fmt(paid)} is more than the new total ${fmt(r.body.total)} — the difference becomes a credit balance.`); }
      if (!a.confirm) return ok(preview(a.kind, r.body, r.warn, { action: 'update ' + docNo(a.kind, old.no), previous_total: fmt(old.total) }));
      const party = await ensureParty(KIND[a.kind].party, r.party);
      const body = { ...old, ...r.body, partyId: party && party.id ? party.id : '', partyName: party ? party.name : r.body.partyName }; delete body.id;
      await db.collection(a.kind).doc(old.id).set(body);
      if ((old.partyId || '') !== body.partyId) {
        for (const p of D.pays.filter(p => p.invoiceId === old.id)) await db.collection('payments').doc(p.id).update({ partyId: body.partyId, partyName: body.partyName, updatedAt: nowIso(), portalDirty: true });
        if (a.kind === 'sales' || a.kind === 'purchases') { const rk = a.kind === 'sales' ? 'sreturns' : 'preturns'; for (const rt of (a.kind === 'sales' ? D.sret : D.pret).filter(x => x.invoiceId === old.id)) await db.collection(rk).doc(rt.id).update({ partyId: body.partyId, partyName: body.partyName, updatedAt: nowIso() }); }
      }
      await log('update', a.kind, old.id, `${docNo(a.kind, old.no)} · ${body.partyName}`);
      return ok({ saved: true, number: docNo(a.kind, old.no), total: fmt(body.total), warnings: r.warn });
    }
    case 'delete_document': {
      if (!KIND[a.kind]) return fail('Unknown kind.');
      const d = await getDocByRef(a.kind, a.number); if (!d) return fail('Document not found.');
      if (D.pays.some(p => p.invoiceId === d.id || p.returnId === d.id)) return fail('Blocked: payments/refunds are linked to this document. Delete those vouchers in the app first.');
      if ((a.kind === 'sales' || a.kind === 'purchases') && (a.kind === 'sales' ? D.sret : D.pret).some(r => r.invoiceId === d.id)) return fail('Blocked: returns are linked to this invoice.');
      if (!a.confirm) return ok({ preview: true, note: 'NOT DELETED. Ask the user to confirm, then call again with confirm=true.', document: summary(a.kind, d, D, s) });
      await db.collection(a.kind).doc(d.id).delete();
      if (a.kind === 'sales' && d.quoteId) await db.collection('quotes').doc(d.quoteId).update({ status: 'open', invoiceId: '' }).catch(() => {});
      if (a.kind === 'sales' && d.woId) await db.collection('workorders').doc(d.woId).update({ status: 'done', invoiceId: '', invoiceNo: '', updatedAt: nowIso() }).catch(() => {});
      if (a.kind === 'purchases' && d.poId) await db.collection('porders').doc(d.poId).update({ status: 'open', invoiceId: '', invoiceNo: '', updatedAt: nowIso() }).catch(() => {});
      if (KIND[a.kind].party === 'customers' && d.partyId) await db.collection('customers').doc(d.partyId).update({ portalDirty: true }).catch(() => {});
      await log('delete', a.kind, d.id, `${docNo(a.kind, d.no)} · ${d.partyName || ''}`);
      return ok({ deleted: true, number: docNo(a.kind, d.no) });
    }
    case 'convert_quote_to_invoice': case 'convert_po_to_purchase': {
      const isQ = name === 'convert_quote_to_invoice'; const src = isQ ? 'quotes' : 'porders', dst = isQ ? 'sales' : 'purchases';
      const q = await getDocByRef(src, a.number); if (!q) return fail('Document not found.');
      if (isQ && q.status === 'converted') return fail('Already converted' + (q.invoiceId ? ' to ' + q.invoiceId : '') + '.');
      if (!isQ && q.status === 'received') return fail('Already received' + (q.invoiceId ? ' as ' + q.invoiceId : '') + '.');
      const date = a.date || todayM();
      const body = { ...q, date, due: isQ && num(s.dueDays) ? addDays(date, num(s.dueDays)) : '', status: 'open', invoiceId: '', quoteId: isQ ? q.id : '', ...(isQ ? {} : { poId: q.id }), createdAt: nowIso(), createdBy: 'claude', updatedAt: nowIso(), updatedBy: 'claude', portalDirty: isQ };
      delete body.id; delete body.no; delete body.lastEmail; delete body.invoiceNo; delete body.remind1h;
      if (!a.confirm) return ok(preview(dst, body, [], { action: `create ${KIND[dst].ar} from ${docNo(src, q.no)}` }));
      const { id, no } = await createNumbered(dst, KIND[dst].prefix, body);
      await db.collection(src).doc(q.id).update({ status: isQ ? 'converted' : 'received', invoiceId: id, ...(isQ ? {} : { invoiceNo: docNo(dst, no) }), updatedAt: nowIso(), portalDirty: isQ });
      await log('create', dst, id, `${docNo(dst, no)} · ${body.partyName} (${docNo(src, q.no)})`);
      return ok({ saved: true, number: docNo(dst, no), id, total: fmt(body.total) });
    }
    case 'set_status': {
      const d = await getDocByRef(a.kind, a.number); if (!d) return fail('Document not found.');
      const allowed = a.kind === 'quotes' ? ['open', 'rejected'] : ['open', 'cancelled'];
      if (!allowed.includes(a.status)) return fail('Status must be one of: ' + allowed.join(', '));
      if ((a.kind === 'quotes' && d.status === 'converted') || (a.kind === 'porders' && d.status === 'received')) return fail('Document already converted/received.');
      if (!a.confirm) return ok({ preview: true, note: 'NOT SAVED. Confirm with the user.', document: docNo(a.kind, d.no), from: d.status || 'open', to: a.status });
      await db.collection(a.kind).doc(d.id).update({ status: a.status, updatedAt: nowIso(), portalDirty: a.kind === 'quotes' });
      await log('update', a.kind, d.id, `${docNo(a.kind, d.no)} → ${a.status}`);
      return ok({ saved: true, number: docNo(a.kind, d.no), status: a.status });
    }
    case 'record_payment': {
      const d = await getDocByRef(a.kind, a.number); if (!d) return fail('Invoice not found.');
      const amount = r3(num(a.amount)); if (amount <= 0) return fail('Amount must be > 0.');
      const rem = r3(num(d.total) - (D.paid.get(d.id) || 0)); const warn = amount > rem + 0.0005 ? [`Amount exceeds the remaining ${fmt(rem)}; the difference becomes a credit.`] : [];
      const t = a.kind === 'sales' ? 'in' : 'out'; const method = a.method || 'cash';
      const accs = Array.isArray(s.accounts) && s.accounts.length ? s.accounts.filter(x => !x.archived) : [{ id: 'cash', type: 'cash' }, { id: 'bank', type: 'bank' }];
      const acc = (accs.find(x => x.type === (method === 'cash' ? 'cash' : 'bank')) || accs[0] || {}).id || '';
      const body = { type: t, date: a.date || todayM(), partyType: a.kind === 'sales' ? 'customer' : 'supplier', partyId: d.partyId || '', partyName: d.partyName || '', invoiceKind: a.kind, invoiceId: d.id, invoiceNo: docNo(a.kind, d.no), amount, method, accountId: a.migrated_from ? '' : acc, notes: a.notes || '', category: '', createdAt: nowIso(), createdBy: 'claude', updatedAt: nowIso(), portalDirty: a.kind === 'sales', ...(a.migrated_from ? { noCash: true, migrated: String(a.migrated_from) } : {}) };
      if (!a.confirm) return ok({ preview: true, note: 'NOT SAVED. Confirm with the user.', invoice: docNo(a.kind, d.no), party: d.partyName, remaining_before: fmt(rem), amount: fmt(amount), method, warnings: warn });
      const { id, no } = await createNumbered('payments', t === 'in' ? 'RV' : 'PV', body, x => x.type === t);
      await log('create', 'payments', id, `${t === 'in' ? 'RV' : 'PV'}-${String(no).padStart(5, '0')} · ${d.partyName} · ${fmt(amount)}`);
      return ok({ saved: true, voucher: `${t === 'in' ? 'RV' : 'PV'}-${String(no).padStart(5, '0')}`, remaining_after: fmt(rem - amount), warnings: warn });
    }
    case 'mark_payment_migrated': {
      const v = String(a.voucher || '').trim().toUpperCase(); const m2 = v.match(/^(RV|PV)\D*(\d+)$/);
      if (!m2) return fail('voucher must look like RV-00001 or PV-00001.');
      const t = m2[1] === 'RV' ? 'in' : 'out', n = parseInt(m2[2], 10);
      const p = D.pays.find(x => x.type === t && num(x.no) === n); if (!p) return fail('Voucher not found.');
      if (!a.confirm) return ok({ preview: true, note: 'NOT SAVED. Confirm with the user.', voucher: v, party: p.partyName, amount: fmt(p.amount), invoice: p.invoiceNo || '', effect: 'will stop counting in the cash box / bank balance' });
      await db.collection('payments').doc(p.id).update({ noCash: true, migrated: String(a.migrated_from || 'النظام السابق'), updatedAt: nowIso() });
      await log('update', 'payments', p.id, `${v} → migrated`);
      return ok({ saved: true, voucher: v });
    }
    case 'create_party': {
      const col = a.type === 'supplier' ? 'suppliers' : 'customers'; const list = col === 'customers' ? D.custs : D.sups;
      const name = String(a.name || '').trim(); if (!name) return fail('name is required.');
      if (findParty(list, name)) return fail('A record with this name already exists.');
      const body = { name, nameEn: a.name_en || '', phone: a.phone || '', email: a.email || '', vatNo: a.vat_no || '', address: a.address || '', city: a.city || '', opening: 0, notes: '', createdAt: nowIso(), createdBy: 'claude', updatedAt: nowIso() };
      if (!a.confirm) return ok({ preview: true, note: 'NOT SAVED. Confirm with the user.', [a.type || 'customer']: body });
      const ref = db.collection(col).doc(); await ref.set(body); await log('create', col, ref.id, name);
      return ok({ saved: true, id: ref.id, name });
    }
    case 'get_party_statement': {
      const isC = a.type !== 'supplier'; const list = isC ? D.custs : D.sups;
      const p = findParty(list, a.party) || (fuzzy(list, a.party, ['name', 'nameEn', 'phone']).length === 1 ? fuzzy(list, a.party, ['name', 'nameEn', 'phone'])[0] : null);
      if (!p) return fail('Not found. Candidates: ' + fuzzy(list, a.party, ['name', 'nameEn', 'phone']).slice(0, 5).map(x => x.name).join(' | '));
      const k = isC ? 'sales' : 'purchases';
      const open = (isC ? D.sales : D.purchases).filter(x => x.partyId === p.id).map(x => summary(k, x, D, s)).filter(x => num(x.remaining) > 0.0005);
      return ok({ name: p.name, balance: fmt((isC ? D.cust : D.sup).get(p.id) || 0), meaning: isC ? 'positive = customer owes us' : 'positive = we owe the supplier', open_invoices: open });
    }
    case 'list_overdue_invoices': {
      const t = todayM();
      const out = D.sales.map(x => ({ x, rem: r3(num(x.total) - (D.paid.get(x.id) || 0)), due: effDue(x, s) })).filter(o => o.rem > 0.0005 && o.due && o.due < t)
        .sort((a1, b1) => a1.due.localeCompare(b1.due)).slice(0, lim(a.limit))
        .map(o => ({ number: docNo('sales', o.x.no), customer: o.x.partyName, date: o.x.date, due: o.due, days_late: Math.round((new Date(t) - new Date(o.due)) / 864e5), remaining: fmt(o.rem) }));
      return ok(out);
    }
  }
  return fail('Unknown tool: ' + name);
}

/* ---------------- MCP over HTTP ---------------- */
let KEY = { v: null, at: 0 };
async function validKey(k) {
  if (!k || k.length < 20) return false;
  if (!KEY.v || Date.now() - KEY.at > 60e3) { const g = await db.doc('meta/mcp').get(); KEY = { v: g.exists ? g.data().key || '' : '', at: Date.now() }; }
  if (!KEY.v || KEY.v.length !== k.length) return false;
  return crypto.timingSafeEqual(Buffer.from(KEY.v), Buffer.from(k));
}
const INSTRUCTIONS = 'SMART CLICK (Oman) accounting app: customers, suppliers, products, quotations (QT), sales invoices (INV), purchase invoices (PUR), purchase orders (PO), returns. Currency OMR (3 decimals), VAT 5% by default. '
  + 'To make a quote/invoice: search_customers → search_products → create_document WITHOUT confirm to get a preview → show the user the lines and totals → call again with confirm=true only after explicit approval. '
  + 'Every write (create/update/delete/convert/payment/status/party) needs confirm=true and must be approved by the user first. Refer to documents by their number (e.g. QT-00012).';

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNote = id === undefined || id === null;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  try {
    if (method === 'initialize') {
      const want = params && params.protocolVersion; const sup = ['2025-06-18', '2025-03-26', '2024-11-05'];
      return reply({ protocolVersion: sup.includes(want) ? want : sup[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'smart-click', version: '1.0.0' }, instructions: INSTRUCTIONS });
    }
    if (isNote) return null; // notifications/initialized etc.
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name; if (!TOOLS.some(t => t.name === name)) return err(-32602, 'Unknown tool');
      try { return reply(await callTool(name, params.arguments)); }
      catch (e) { console.error(name, e); return reply(fail('Error: ' + (e.message || e))); }
    }
    if (method === 'resources/list') return reply({ resources: [] });
    if (method === 'prompts/list') return reply({ prompts: [] });
    return err(-32601, 'Method not found');
  } catch (e) { console.error(e); return err(-32603, 'Internal error'); }
}

exports.mcpHandler = async (req, res) => {
  const key = (req.path || '').split('/').filter(Boolean)[0] || '';
  if (!(await validKey(key))) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (req.method === 'GET') { res.status(405).set('Allow', 'POST').send('Use POST'); return; }
  if (req.method === 'DELETE') { res.status(200).send(''); return; }
  if (req.method !== 'POST') { res.status(405).send(''); return; }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  if (Array.isArray(body)) { const out = (await Promise.all(body.map(handle))).filter(Boolean); if (!out.length) { res.status(202).send(''); return; } res.json(out); return; }
  const r = await handle(body);
  if (!r) { res.status(202).send(''); return; }
  res.json(r);
};
exports._test = { callTool, handle, TOOLS };
