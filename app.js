'use strict';
/* ===================================================================
   BTC INVENTORY - aplikasi PWA inventory gudang FMCG
   Bagian 1: utilitas, status aplikasi, koneksi Supabase, cache SKU
   =================================================================== */
const APP_VERSION = '1.0.0';
const TZ = 'Asia/Jakarta';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('id-ID');
const fmtN = (n) => nf.format(Math.round(Number(n) || 0));
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const fmtDate = (s) => { if (!s) return '-'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const fmtDateTime = (ts) => {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('id-ID', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthRange = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
};
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const fmtMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (r) => { if (r.error) throw r.error; return r.data; };
const intOr = (v, d = 0) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : d; };

/* ---------- status aplikasi ---------- */
const S = {
  profile: null,
  skus: [], skusAt: 0, byId: new Map(), byCode: new Map(), byBarcode: new Map(), byBarcodeStrip: new Map(),
  installEvt: null,
  skuUi: { q: '', filter: 'all', limit: 60 },
  forms: {},
  hist: null, rep: null, kartu: null,
};
let sb = null;

/* ---------- jenis transaksi ---------- */
const TRX = {
  inbound:         { label: 'Barang Masuk',          short: 'Masuk',        css: 'in',  sign: 1,  bucket: 'good',    party: 'Supplier / asal barang', ref: 'No. Surat Jalan / PO', hero: 'in',  desc: 'Stok bagus bertambah.' },
  outbound:        { label: 'Barang Keluar',         short: 'Keluar',       css: 'out', sign: -1, bucket: 'good',    party: 'Customer / toko tujuan', ref: 'No. Surat Jalan / DO', hero: 'out', desc: 'Stok bagus berkurang.' },
  return_good:     { label: 'Retur Bagus',           short: 'Retur Bagus',  css: 'ret', sign: 1,  bucket: 'good',    party: 'Customer / asal retur',  ref: 'No. Retur / Nota',     hero: 'ret', desc: 'Barang retur masih layak jual: masuk ke stok bagus.' },
  return_damaged:  { label: 'Retur Rusak',           short: 'Retur Rusak',  css: 'dmg', sign: 1,  bucket: 'damaged', party: 'Customer / asal retur',  ref: 'No. Retur / Nota',     hero: 'dmg', desc: 'Barang retur rusak / kedaluwarsa: masuk ke stok rusak (terpisah).' },
  dispose_damaged: { label: 'Keluarkan Stok Rusak',  short: 'Rusak Keluar', css: 'gray', sign: -1, bucket: 'damaged', party: 'Tujuan (musnah / retur ke supplier)', ref: 'No. Berita Acara', hero: 'dispose', desc: 'Stok rusak berkurang (dimusnahkan atau dikembalikan ke supplier).' },
  opname:          { label: 'Penyesuaian Opname',    short: 'Opname',       css: 'info', sign: 0 },
  void:            { label: 'Pembatalan Transaksi',  short: 'Pembatalan',   css: 'gray', sign: 0 },
};
const BUCKET = { good: 'Bagus', damaged: 'Rusak' };

/* ---------- hak akses (di server tetap dicek ulang; ini hanya untuk tampilan) ---------- */
const ROLES = { admin: 'Admin', supervisor: 'Supervisor', staff: 'Staff Gudang', viewer: 'Viewer (hanya lihat)' };
const PERM = {
  trx: ['admin', 'supervisor', 'staff'],
  dispose: ['admin', 'supervisor'],
  sku_edit: ['admin', 'supervisor'],
  opname_count: ['admin', 'supervisor', 'staff'],
  opname_final: ['admin', 'supervisor'],
  void: ['admin', 'supervisor'],
  users: ['admin'],
};
const can = (what) => !!(S.profile && PERM[what] && PERM[what].includes(S.profile.role));

/* ---------- pesan galat yang ramah ---------- */
function errMsg(e) {
  const raw = (e && (e.message || e.error_description || e.msg)) || String(e || 'Terjadi kesalahan.');
  const m = String(raw);
  if (/Failed to fetch|NetworkError|Load failed|network request failed|fetch failed/i.test(m)) return 'Tidak ada koneksi internet atau server tidak terjangkau. Periksa sinyal lalu coba lagi.';
  if (/skus_code_uq|duplicate key.*sku_code/i.test(m)) return 'Kode SKU sudah dipakai barang lain.';
  if (/skus_barcode_carton_uq/i.test(m)) return 'Barcode dus sudah dipakai SKU lain.';
  if (/skus_barcode_uq/i.test(m)) return 'Barcode satuan sudah dipakai SKU lain.';
  if (/Invalid login credentials/i.test(m)) return 'Email atau kata sandi salah.';
  if (/User already registered|already been registered/i.test(m)) return 'Email ini sudah terdaftar. Silakan masuk.';
  if (/Email not confirmed/i.test(m)) return 'Email belum dikonfirmasi. Minta admin mematikan "Confirm email" di pengaturan Supabase.';
  if (/Password should be at least/i.test(m)) return 'Kata sandi minimal 6 karakter.';
  if (/JWT expired|invalid JWT|refresh_token/i.test(m)) return 'Sesi login berakhir. Silakan masuk lagi.';
  if (/row-level security|permission denied/i.test(m)) return 'Anda tidak memiliki hak akses untuk tindakan ini.';
  if (/rate limit|too many requests|over_email_send_rate_limit/i.test(m)) return 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.';
  if (/Could not find the function|schema cache/i.test(m)) return 'Struktur database belum lengkap. Jalankan ulang file database.sql di Supabase (SQL Editor), lalu coba lagi.';
  if (/JSON object requested/i.test(m)) return 'Data tidak ditemukan.';
  return m;
}
const isNetworkErr = (e) => /Failed to fetch|NetworkError|Load failed|network request failed|fetch failed/i.test(String((e && e.message) || e));

/* ---------- koneksi Supabase ---------- */
function getConfig() {
  const c = window.BTC_CONFIG || {};
  let url = (localStorage.getItem('btc_sb_url') || c.SUPABASE_URL || '').trim();
  let key = (localStorage.getItem('btc_sb_key') || c.SUPABASE_KEY || '').trim();
  const ok = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url) && key.length > 20 && !/ISI_/.test(key);
  return { url: url.replace(/\/+$/, ''), key, ok };
}
function initSupabase() {
  const cfg = getConfig();
  if (!cfg.ok) return false;
  sb = supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'btc-inventory-auth' },
  });
  return true;
}

/* ---------- ambil semua baris (Supabase membatasi 1000 baris per permintaan) ---------- */
async function fetchAll(build, pageSize = 1000) {
  let all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
  }
  return all;
}

/* ---------- cache SKU + saldo ---------- */
function indexSkus() {
  S.byId = new Map(); S.byCode = new Map(); S.byBarcode = new Map(); S.byBarcodeStrip = new Map();
  for (const s of S.skus) {
    s._hay = `${s.sku_code} ${s.name} ${s.barcode || ''} ${s.barcode_carton || ''} ${s.category || ''}`.toLowerCase();
    S.byId.set(s.sku_id, s);
    S.byCode.set(String(s.sku_code).toUpperCase(), s);
    const upc = s.units_per_carton || 1;
    if (s.barcode) {
      S.byBarcode.set(s.barcode, { sku: s, factor: 1, via: 'barcode' });
      S.byBarcodeStrip.set(s.barcode.replace(/^0+/, ''), { sku: s, factor: 1, via: 'barcode' });
    }
    if (s.barcode_carton) {
      S.byBarcode.set(s.barcode_carton, { sku: s, factor: upc, via: 'dus' });
      S.byBarcodeStrip.set(s.barcode_carton.replace(/^0+/, ''), { sku: s, factor: upc, via: 'dus' });
    }
  }
}
async function loadSkus(force = false) {
  if (!force && S.skus.length && Date.now() - S.skusAt < 15000) return S.skus;
  S.skus = await fetchAll(() => sb.from('v_stock').select('*').order('sku_code'));
  S.skusAt = Date.now();
  indexSkus();
  return S.skus;
}
/* cari SKU dari hasil scan / ketikan: barcode satuan, barcode dus, atau kode SKU */
function findByCode(raw) {
  const c = String(raw || '').trim();
  if (!c) return null;
  const hit = S.byBarcode.get(c);
  if (hit) return hit;
  const sku = S.byCode.get(c.toUpperCase());
  if (sku) return { sku, factor: 1, via: 'kode' };
  const z = c.replace(/^0+/, '');
  if (z) { const h2 = S.byBarcodeStrip.get(z); if (h2) return h2; }
  return null;
}
function searchSkus(q, { onlyActive = true, limit = 50, filter = null } = {}) {
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  let list = S.skus;
  if (onlyActive) list = list.filter((s) => s.is_active);
  if (filter) list = list.filter(filter);
  if (tokens.length) list = list.filter((s) => tokens.every((t) => s._hay.includes(t)));
  return limit ? list.slice(0, limit) : list;
}

/* ---------- tampilan angka stok ---------- */
function dusText(qty, s) {
  const upc = (s && s.units_per_carton) || 1;
  qty = Number(qty) || 0;
  if (upc > 1 && qty >= upc) {
    const d = Math.floor(qty / upc), p = qty % upc;
    return `${fmtN(d)} dus` + (p ? ` + ${fmtN(p)} ${s.unit}` : '');
  }
  return '';
}
function stockBadge(s) {
  if (!s.is_active) return '<span class="badge gray">Nonaktif</span>';
  if (s.qty_good <= 0) return '<span class="badge red">Habis</span>';
  if (s.min_stock > 0 && s.qty_good <= s.min_stock) return '<span class="badge amber">Menipis</span>';
  return '';
}
const trxBadge = (type) => `<span class="badge ${(TRX[type] || {}).css || 'gray'}">${esc((TRX[type] || {}).short || type)}</span>`;
const loadingHtml = (t = 'Memuat data…') => `<div class="empty"><div class="spinner"></div><div class="mt">${esc(t)}</div></div>`;
const emptyHtml = (icon, t, sub = '') => `<div class="empty"><div class="big">${icon}</div><div class="bold">${esc(t)}</div>${sub ? `<div class="small mt-s">${esc(sub)}</div>` : ''}</div>`;

/* ===================================================================
   Bagian 2: komponen tampilan (toast, jendela, konfirmasi), ekspor, pemindai barcode
   =================================================================== */

/* ---------- toast ---------- */
function toast(msg, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const toastErr = (e) => toast(errMsg(e), 'err', 5200);

/* ---------- jendela dari bawah (sheet) ---------- */
const sheets = [];
function openSheet(html, onMount) {
  const root = $('#sheet-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const el = document.createElement('div');
  el.className = 'sheet';
  el.innerHTML = '<div class="sheet-grip"></div>' + html;
  root.appendChild(backdrop);
  root.appendChild(el);
  document.body.classList.add('noscroll');
  const api = { el, onClose: null, close() {
    const i = sheets.indexOf(api);
    if (i < 0) return;
    sheets.splice(i, 1);
    backdrop.remove(); el.remove();
    if (!sheets.length) document.body.classList.remove('noscroll');
    if (api.onClose) { const f = api.onClose; api.onClose = null; f(); }
  } };
  backdrop.addEventListener('click', () => api.close());
  $$('[data-close]', el).forEach((b) => b.addEventListener('click', () => api.close()));
  sheets.push(api);
  if (onMount) onMount(el, api);
  return api;
}
function closeAllOverlays() {
  while (sheets.length) sheets[sheets.length - 1].close();
  $('#modal-root').innerHTML = '';
  stopScanner(true);
}

/* ---------- kotak konfirmasi / pesan ---------- */
function confirmBox({ title = 'Konfirmasi', text = '', ok = 'Ya', cancel = 'Batal', danger = false, html = '' }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog"><h2>${esc(title)}</h2>${html || `<p>${esc(text)}</p>`}
      <div class="btn-row">${cancel ? `<button class="btn" data-r="0">${esc(cancel)}</button>` : ''}
      <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div></div>`;
    root.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    $$('[data-r]', wrap).forEach((b) => b.addEventListener('click', () => done(b.dataset.r === '1')));
    wrap.addEventListener('click', (e) => { if (e.target === wrap && cancel) done(false); });
  });
}
const alertBox = (title, text) => confirmBox({ title, text, ok: 'OK', cancel: '' });

/* kotak isian teks (mis. alasan pembatalan) */
function promptBox({ title, label, placeholder = '', ok = 'Simpan', danger = false, minLen = 0 }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal"><h2>${esc(title)}</h2>
      <div class="field"><label>${esc(label)}</label><textarea class="input" id="pb-in" placeholder="${esc(placeholder)}"></textarea>
      <div class="err-text" id="pb-err" hidden></div></div>
      <div class="btn-row"><button class="btn" data-r="0">Batal</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div></div>`;
    root.appendChild(wrap);
    const inp = $('#pb-in', wrap);
    setTimeout(() => inp.focus(), 50);
    const done = (v) => { wrap.remove(); resolve(v); };
    $$('[data-r]', wrap).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.r === '0') return done(null);
      const v = inp.value.trim();
      if (v.length < minLen) { const e = $('#pb-err', wrap); e.hidden = false; e.textContent = `Isi minimal ${minLen} huruf.`; return; }
      done(v);
    }));
  });
}

/* ---------- tombol sedang proses ---------- */
async function withBusy(btn, fn) {
  if (btn.disabled) return;
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm"></span> Memproses…';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; }
}

/* ===================================================================
   EKSPOR EXCEL / CSV
   =================================================================== */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
const safeName = (s) => String(s).replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '_');
function exportXlsx(filename, sheetsDef) {
  if (typeof XLSX === 'undefined') { toast('Pustaka Excel belum termuat. Muat ulang halaman.', 'err'); return; }
  const wb = XLSX.utils.book_new();
  sheetsDef.forEach((sh, i) => {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    const w = sh.rows.reduce((acc, r) => { r.forEach((c, j) => { acc[j] = Math.max(acc[j] || 8, Math.min(46, String(c ?? '').length + 2)); }); return acc; }, []);
    ws['!cols'] = w.map((x) => ({ wch: x }));
    XLSX.utils.book_append_sheet(wb, ws, String(sh.name || 'Sheet' + (i + 1)).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  });
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), safeName(filename) + '.xlsx');
  toast('File Excel diunduh. Cek folder Download di HP.', 'ok');
}
function exportCsv(filename, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; // cegah rumus tak sengaja
    return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), safeName(filename) + '.csv');
  toast('File CSV diunduh. Cek folder Download di HP.', 'ok');
}
/* tombol "Unduh" -> pilih Excel atau CSV */
function exportMenu(title, filename, buildSheets) {
  openSheet(`<h2>${esc(title)}</h2>
    <p class="muted small">Pilih format file. File akan tersimpan di folder Download HP Anda.</p>
    <div class="btn-row"><button class="btn primary" id="ex-x">Excel (.xlsx)</button><button class="btn" id="ex-c">CSV (.csv)</button></div>
    <button class="btn block ghost mt" data-close>Batal</button>`, (el, api) => {
    const run = (kind) => async (ev) => {
      await withBusy(ev.currentTarget, async () => {
        try {
          const sheetsDef = await buildSheets();
          if (kind === 'x') exportXlsx(filename, sheetsDef);
          else sheetsDef.forEach((sh, i) => exportCsv(sheetsDef.length > 1 ? `${filename}_${sh.name}` : filename, sh.rows));
          api.close();
        } catch (e) { toastErr(e); }
      });
    };
    $('#ex-x', el).addEventListener('click', run('x'));
    $('#ex-c', el).addEventListener('click', run('c'));
  });
}

/* ===================================================================
   PEMINDAI BARCODE (kamera HP)
   =================================================================== */
let qr = null, qrBusy = false;
function beep(ok = true) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = beep.ctx || (beep.ctx = new AC());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = ok ? 1100 : 300;
    g.gain.value = 0.12;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + (ok ? 0.09 : 0.28));
  } catch (_) { /* abaikan */ }
  try { navigator.vibrate && navigator.vibrate(ok ? 50 : [80, 60, 80]); } catch (_) { /* abaikan */ }
}
async function stopScanner(silent) {
  const root = $('#scanner-root');
  if (qr) {
    try { if (qr.isScanning) await qr.stop(); } catch (_) { /* abaikan */ }
    try { qr.clear(); } catch (_) { /* abaikan */ }
    qr = null;
  }
  qrBusy = false;
  root.hidden = true;
  root.innerHTML = '';
  if (!silent && !sheets.length) document.body.classList.remove('noscroll');
}
/*
  openScanner({ title, hint, onScan })
  onScan(kode) harus mengembalikan { ok: true/false, msg: '...' }
  Pemindai tetap terbuka (mode beruntun) sampai pengguna menekan "Selesai".
*/
function openScanner({ title = 'Pindai Barcode', hint = 'Arahkan kamera ke barcode barang', onScan, single = false }) {
  const root = $('#scanner-root');
  root.hidden = false;
  document.body.classList.add('noscroll');
  root.innerHTML = `
    <div class="scan-top"><h2>${esc(title)}</h2><button class="btn sm" id="sc-done">Selesai</button></div>
    <div class="scan-view"><div id="qr-reader"></div></div>
    <div class="scan-bottom">
      <div class="scan-last" id="sc-last">${esc(hint)}</div>
      <div class="input-group mt-s"><input class="input" id="sc-manual" inputmode="text" autocomplete="off" placeholder="Atau ketik kode lalu tekan OK">
      <button class="btn" id="sc-ok">OK</button></div>
      <div class="row mt-s"><label class="btn sm ghost" style="color:#fff;border-color:#4b5563">Foto barcode
      <input type="file" id="sc-file" accept="image/*" hidden></label></div>
    </div>`;
  let last = { code: '', t: 0 };
  const showLast = (r, code) => {
    $('#sc-last').innerHTML = r && r.msg ? `<span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✔' : '✖'} ${esc(r.msg)}</span><div class="tiny" style="opacity:.7">${esc(code)}</div>` : esc(hint);
  };
  const handle = async (code) => {
    code = String(code || '').trim();
    if (!code || qrBusy) return;
    const now = Date.now();
    if (code === last.code && now - last.t < 1800) return; // abaikan pembacaan ganda
    last = { code, t: now };
    qrBusy = true;
    let r;
    try { r = (await onScan(code)) || { ok: true }; } catch (e) { r = { ok: false, msg: errMsg(e) }; }
    beep(r.ok);
    showLast(r, code);
    qrBusy = false;
    last.t = Date.now();
    if (single && r.ok) stopScanner();
  };
  $('#sc-done').addEventListener('click', () => stopScanner());
  const man = $('#sc-manual');
  const goManual = () => { const v = man.value.trim(); man.value = ''; if (v) handle(v); };
  $('#sc-ok').addEventListener('click', goManual);
  man.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goManual(); } });

  if (typeof Html5Qrcode === 'undefined') { showLast({ ok: false, msg: 'Pustaka pemindai belum termuat. Ketik kode secara manual.' }, ''); return; }
  const F = Html5QrcodeSupportedFormats;
  qr = new Html5Qrcode('qr-reader', {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE, F.CODE_93, F.CODABAR],
    useBarCodeDetectorIfSupported: true, verbose: false,
  });
  qr.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: (w, h) => ({ width: Math.floor(Math.min(w, 420) * 0.9), height: Math.floor(Math.min(h, 300) * 0.5) }) },
    (text) => handle(text),
    () => {}
  ).catch((err) => {
    const m = String((err && err.message) || err);
    const msg = /Permission|NotAllowed/i.test(m)
      ? 'Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan browser, atau ketik kode secara manual.'
      : /NotFound|Requested device/i.test(m) ? 'Kamera tidak ditemukan. Ketik kode secara manual.'
      : 'Kamera tidak bisa dibuka (' + m.slice(0, 80) + '). Ketik kode secara manual.';
    showLast({ ok: false, msg }, '');
  });
  $('#sc-file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      const holder = new Html5Qrcode('qr-reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE], verbose: false });
      const res = await holder.scanFile(f, false);
      handle(res);
    } catch (_) { showLast({ ok: false, msg: 'Barcode tidak terbaca dari foto. Coba foto lebih dekat & jelas.' }, ''); }
  });
}

/* ===================================================================
   PEMILIH SKU (cari atau pindai), dipakai di form transaksi / opname / kartu stok
   =================================================================== */
function openSkuPicker({ title = 'Pilih Barang', onlyActive = true, onPick, filter = null, showStock = 'good' }) {
  openSheet(`<h2>${esc(title)}</h2>
    <div class="input-group"><input class="input" id="pk-q" placeholder="Cari nama / kode / barcode" autocomplete="off">
    <button class="btn" id="pk-scan" aria-label="Pindai">📷</button></div>
    <div id="pk-list" class="card pad0 mt"></div>`, (el, api) => {
    const q = $('#pk-q', el), list = $('#pk-list', el);
    const draw = () => {
      const res = searchSkus(q.value, { onlyActive, limit: 40, filter });
      if (!res.length) { list.innerHTML = emptyHtml('🔎', 'Barang tidak ditemukan', 'Periksa ejaan atau pindai barcode.'); return; }
      list.innerHTML = res.map((s) => `<div class="list-item" data-id="${s.sku_id}">
        <div class="grow"><div class="t ellipsis">${esc(s.name)}</div>
        <div class="small muted ellipsis">${esc(s.sku_code)}${s.barcode ? ' · ' + esc(s.barcode) : ''}</div></div>
        <div class="qty-box"><div class="n">${fmtN(showStock === 'damaged' ? s.qty_damaged : s.qty_good)}</div><div class="small muted">${esc(s.unit)}</div></div></div>`).join('');
    };
    q.addEventListener('input', debounce(draw, 120));
    list.addEventListener('click', (ev) => {
      const it = ev.target.closest('[data-id]'); if (!it) return;
      const s = S.byId.get(it.dataset.id);
      api.close(); onPick(s, { factor: 1, via: 'cari' });
    });
    q.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const hit = findByCode(q.value);
      if (hit && (hit.sku.is_active || !onlyActive)) { api.close(); onPick(hit.sku, hit); }
    });
    $('#pk-scan', el).addEventListener('click', () => {
      openScanner({ title: 'Pindai barang', single: true, onScan: (code) => {
        const hit = findByCode(code);
        if (!hit) return { ok: false, msg: 'Barcode tidak terdaftar di Master SKU.' };
        if (onlyActive && !hit.sku.is_active) return { ok: false, msg: 'SKU nonaktif.' };
        api.close(); onPick(hit.sku, hit);
        return { ok: true, msg: hit.sku.name };
      } });
    });
    draw();
    setTimeout(() => q.focus(), 120);
  });
}

/* ===================================================================
   Bagian 3: login, kerangka aplikasi (menu bawah), router
   =================================================================== */
const appEl = () => $('#app');

/* ---------- layar pengaturan koneksi (jika config.js belum diisi) ---------- */
function renderSetup() {
  appEl().hidden = false; $('#boot').hidden = true;
  appEl().innerHTML = `<div class="auth-wrap">
    <div class="auth-logo"><img src="icon-192.png" alt=""><h1>BTC INVENTORY</h1><p>Pengaturan koneksi database</p></div>
    <div class="card">
      <p class="small">Aplikasi belum terhubung ke Supabase. Isi dua data berikut dari Supabase
      (menu <b>Project Settings → API</b>). Cara permanen untuk semua HP: isi file <b>config.js</b> di GitHub.</p>
      <div class="field"><label>Project URL</label><input class="input" id="su-url" placeholder="https://xxxx.supabase.co" autocapitalize="off" autocomplete="off"></div>
      <div class="field"><label>Publishable key (atau anon key)</label><textarea class="input" id="su-key" placeholder="sb_publishable_..." autocapitalize="off"></textarea></div>
      <div class="err-text" id="su-err" hidden></div>
      <button class="btn primary block" id="su-save">Simpan & Hubungkan</button>
    </div></div>`;
  $('#su-save').addEventListener('click', () => {
    const url = $('#su-url').value.trim().replace(/\/+$/, ''), key = $('#su-key').value.trim();
    const err = $('#su-err');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) { err.hidden = false; err.textContent = 'Alamat tidak sesuai. Contoh: https://abcdefgh.supabase.co'; return; }
    if (key.length < 20) { err.hidden = false; err.textContent = 'Kunci terlalu pendek. Salin utuh dari Supabase.'; return; }
    if (/service_role|secret/i.test(key) && !/^sb_publishable_|^eyJ/.test(key)) { err.hidden = false; err.textContent = 'Jangan pakai kunci "secret". Pakai kunci publishable/anon.'; return; }
    try { const p = JSON.parse(atob(key.split('.')[1] || '')); if (p.role === 'service_role') { err.hidden = false; err.textContent = 'Itu kunci service_role (rahasia). Pakai kunci anon / publishable.'; return; } } catch (_) { /* bukan JWT */ }
    localStorage.setItem('btc_sb_url', url); localStorage.setItem('btc_sb_key', key);
    location.reload();
  });
}

/* ---------- layar login / daftar ---------- */
function renderAuth(mode = 'login', notice = '') {
  appEl().hidden = false; $('#boot').hidden = true;
  const isReg = mode === 'register';
  appEl().innerHTML = `<div class="auth-wrap">
    <div class="auth-logo"><img src="icon-192.png" alt=""><h1>BTC INVENTORY</h1><p>Manajemen stok gudang FMCG</p></div>
    <form class="card" id="auth-form" autocomplete="on">
      <h2 style="font-size:18px;margin-bottom:12px">${isReg ? 'Daftar Akun Baru' : 'Masuk'}</h2>
      ${notice ? `<div class="card flat small" style="background:var(--info-soft);color:var(--info)">${esc(notice)}</div>` : ''}
      ${isReg ? `<div class="field"><label>Nama lengkap</label><input class="input" id="au-name" autocomplete="name" required></div>` : ''}
      <div class="field"><label>Email</label><input class="input" id="au-email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" required></div>
      <div class="field"><label>Kata sandi</label><input class="input" id="au-pass" type="password" autocomplete="${isReg ? 'new-password' : 'current-password'}" ${isReg ? 'minlength="6"' : ''} required>
        ${isReg ? '<div class="hint">Minimal 6 karakter.</div>' : ''}</div>
      <div class="err-text" id="au-err" hidden></div>
      <button class="btn primary block" type="submit" id="au-go">${isReg ? 'Daftar' : 'Masuk'}</button>
      <div class="center mt-s"><button type="button" class="link-btn" id="au-switch">${isReg ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar'}</button></div>
      ${isReg ? '<p class="hint center">Akun pertama otomatis menjadi Admin. Akun berikutnya harus disetujui Admin sebelum bisa dipakai.</p>' : ''}
    </form></div>`;
  $('#au-switch').addEventListener('click', () => renderAuth(isReg ? 'login' : 'register'));
  $('#auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('#au-email').value.trim(), pass = $('#au-pass').value;
    const err = $('#au-err'); err.hidden = true;
    await withBusy($('#au-go'), async () => {
      try {
        if (isReg) {
          const name = $('#au-name').value.trim();
          const r = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
          if (r.error) throw r.error;
          if (!r.data.session) {
            renderAuth('login', 'Pendaftaran berhasil. Jika diminta, konfirmasi email Anda dahulu, lalu masuk.');
            return;
          }
        } else {
          const r = await sb.auth.signInWithPassword({ email, password: pass });
          if (r.error) throw r.error;
        }
        await afterLogin();
      } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    });
  });
}

/* ---------- setelah login: muat profil ---------- */
async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) throw error;
  S.profile = data;
  return data;
}
async function afterLogin() {
  let p;
  try { p = await loadProfile(); } catch (e) {
    appEl().hidden = false; $('#boot').hidden = true;
    appEl().innerHTML = `<div class="auth-wrap"><div class="card"><h2>Tidak bisa memuat profil</h2>
      <p class="small">${esc(errMsg(e))}</p>
      <p class="small muted">Jika ini pertama kali, pastikan file <b>database.sql</b> sudah dijalankan di Supabase.</p>
      <button class="btn primary block" id="retry">Coba lagi</button>
      <button class="btn block mt-s" id="lo">Keluar</button></div></div>`;
    $('#retry').addEventListener('click', () => location.reload());
    $('#lo').addEventListener('click', doLogout);
    return;
  }
  if (!p) {
    appEl().hidden = false; $('#boot').hidden = true;
    appEl().innerHTML = `<div class="auth-wrap"><div class="card"><h2>Profil belum ada</h2>
      <p class="small">Akun Anda belum punya profil di database. Biasanya karena <b>database.sql</b> dijalankan setelah akun dibuat, atau belum dijalankan sama sekali. Jalankan file tersebut di Supabase lalu coba lagi.</p>
      <button class="btn primary block" id="retry">Coba lagi</button><button class="btn block mt-s" id="lo">Keluar</button></div></div>`;
    $('#retry').addEventListener('click', () => location.reload());
    $('#lo').addEventListener('click', doLogout);
    return;
  }
  if (!p.is_active) { renderPending(); return; }
  try { await loadSkus(true); } catch (e) { toastErr(e); }
  renderShell();
  if (!location.hash || location.hash === '#') location.hash = '#/';
  route();
}
function renderPending() {
  appEl().hidden = false; $('#boot').hidden = true;
  appEl().innerHTML = `<div class="auth-wrap"><div class="auth-logo"><img src="icon-192.png" alt=""><h1>BTC INVENTORY</h1></div>
    <div class="card center"><div style="font-size:40px">⏳</div><h2 class="mt-s">Menunggu persetujuan Admin</h2>
    <p class="muted small">Akun <b>${esc(S.profile.email)}</b> sudah terdaftar tetapi belum diaktifkan. Minta Admin gudang membuka menu <b>Pengguna</b> lalu mengaktifkan akun Anda.</p>
    <button class="btn primary block" id="pn-re">Periksa lagi</button>
    <button class="btn block mt-s" id="pn-lo">Keluar</button></div></div>`;
  $('#pn-re').addEventListener('click', async (ev) => withBusy(ev.currentTarget, async () => {
    try { await loadProfile(); if (S.profile && S.profile.is_active) await afterLogin(); else toast('Akun belum diaktifkan.'); } catch (e) { toastErr(e); }
  }));
  $('#pn-lo').addEventListener('click', doLogout);
}
async function doLogout() {
  try { await sb.auth.signOut(); } catch (_) { /* abaikan */ }
  S.profile = null; S.skus = []; S.forms = {}; S.hist = null; S.rep = null; S.kartu = null;
  closeAllOverlays();
  location.hash = '';
  renderAuth('login');
}

/* ---------- kerangka aplikasi ---------- */
const NAV = [
  { href: '#/', ic: '🏠', t: 'Beranda', key: 'home' },
  { href: '#/masuk', ic: '📥', t: 'Masuk', key: 'masuk' },
  { href: '#/keluar', ic: '📤', t: 'Keluar', key: 'keluar' },
  { href: '#/sku', ic: '📦', t: 'Stok', key: 'sku' },
  { href: '#/menu', ic: '☰', t: 'Menu', key: 'menu' },
];
function renderShell() {
  $('#boot').hidden = true;
  appEl().hidden = false;
  appEl().innerHTML = `
    <header class="topbar"><button class="icon-btn" id="tb-back" hidden aria-label="Kembali">←</button>
      <h1 id="tb-title">BTC INVENTORY</h1>
      <button class="icon-btn" id="tb-scan" aria-label="Cari barcode">📷</button>
      <button class="icon-btn" id="tb-refresh" aria-label="Muat ulang">↻</button></header>
    <div class="offline-bar" id="offline-bar" hidden>Tidak ada koneksi internet. Transaksi tidak dapat disimpan sampai tersambung.</div>
    <main id="view"></main>
    <nav class="bottom-nav">${NAV.map((n) => `<a href="${n.href}" data-nav="${n.key}"><span class="ic">${n.ic}</span>${n.t}</a>`).join('')}</nav>`;
  $('#tb-back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/'; });
  $('#tb-refresh').addEventListener('click', async () => { try { await loadSkus(true); } catch (e) { toastErr(e); } route(true); });
  $('#tb-scan').addEventListener('click', quickScan);
  updateOnline();
}
function updateOnline() {
  const b = $('#offline-bar');
  if (b) b.hidden = navigator.onLine;
}
window.addEventListener('online', () => { updateOnline(); toast('Koneksi kembali tersambung.', 'ok'); });
window.addEventListener('offline', updateOnline);

/* pindai cepat dari bar atas: lihat info stok barang */
function quickScan() {
  openScanner({ title: 'Cek stok barang', hint: 'Pindai barcode untuk melihat stok', onScan: (code) => {
    const hit = findByCode(code);
    if (!hit) return { ok: false, msg: 'Barcode tidak terdaftar di Master SKU.' };
    stopScanner();
    showSkuSheet(hit.sku.sku_id);
    return { ok: true, msg: hit.sku.name };
  } });
}

/* ---------- router ---------- */
const ROUTES = {
  '': { title: 'BTC INVENTORY', nav: 'home', render: pageHome },
  'masuk': { title: 'Barang Masuk', nav: 'masuk', render: (v) => pageTrxForm(v, 'inbound') },
  'keluar': { title: 'Barang Keluar', nav: 'keluar', render: (v) => pageTrxForm(v, 'outbound') },
  'retur': { title: 'Retur', nav: 'menu', back: true, render: pageRetur },
  'sku': { title: 'Master SKU & Stok', nav: 'sku', render: pageSku },
  'opname': { title: 'Stock Opname', nav: 'menu', back: true, render: pageOpname },
  'opname/:id': { title: 'Hitung Opname', nav: 'menu', back: true, render: pageOpnameDetail },
  'kartu': { title: 'Kartu Stok', nav: 'menu', back: true, render: pageKartu },
  'riwayat': { title: 'Riwayat Transaksi', nav: 'menu', back: true, render: pageRiwayat },
  'laporan': { title: 'Laporan', nav: 'menu', back: true, render: pageLaporan },
  'pengguna': { title: 'Pengguna', nav: 'menu', back: true, render: pagePengguna },
  'akun': { title: 'Akun Saya', nav: 'menu', back: true, render: pageAkun },
  'menu': { title: 'Menu', nav: 'menu', render: pageMenu },
};
let routeToken = 0;
function matchRoute(path) {
  const parts = path.split('/').filter(Boolean);
  for (const key of Object.keys(ROUTES)) {
    const kp = key.split('/').filter(Boolean);
    if (kp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    kp.forEach((seg, i) => { if (seg[0] === ':') params[seg.slice(1)] = decodeURIComponent(parts[i]); else if (seg !== parts[i]) ok = false; });
    if (ok) return { r: ROUTES[key], params };
  }
  return null;
}
async function route(force = false) {
  if (!S.profile || !S.profile.is_active || !$('#view')) return;
  closeAllOverlays();
  const raw = (location.hash || '#/').replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const m = matchRoute(path) || { r: ROUTES[''], params: {} };
  const qs = Object.fromEntries(new URLSearchParams(query));
  const view = $('#view');
  const token = ++routeToken;
  view.className = '';
  view.innerHTML = loadingHtml();
  $('#tb-title').textContent = m.r.title;
  $('#tb-back').hidden = !m.r.back;
  $$('.bottom-nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === m.r.nav));
  window.scrollTo(0, 0);
  try {
    if (!S.skus.length || force || Date.now() - S.skusAt > 15000) await loadSkus(true);
    if (token !== routeToken) return;
    view.innerHTML = '';
    await m.r.render(view, { params: m.params, qs, token, force });
  } catch (e) {
    if (token !== routeToken) return;
    if (/JWT|expired|not authenticated/i.test(String(e && e.message))) { doLogout(); return; }
    view.innerHTML = `<div class="card"><h2>Gagal memuat halaman</h2><p class="small">${esc(errMsg(e))}</p>
      <button class="btn primary block" id="rt-retry">Coba lagi</button></div>`;
    $('#rt-retry').addEventListener('click', () => route(true));
  }
}
window.addEventListener('hashchange', () => route());

/* ---------- halaman Menu ---------- */
async function pageMenu(v) {
  const p = S.profile;
  const tiles = [
    ['#/retur', '↩️', 'Retur Bagus / Rusak', true],
    ['#/opname', '📋', 'Stock Opname', true],
    ['#/kartu', '🗂️', 'Kartu Stok', true],
    ['#/riwayat', '🕘', 'Riwayat Transaksi', true],
    ['#/laporan', '📊', 'Laporan Harian & Bulanan', true],
    ['#/pengguna', '👥', 'Pengguna', can('users')],
    ['#/akun', '👤', 'Akun Saya', true],
  ].filter((t) => t[3]);
  v.innerHTML = `<div class="card"><div class="row"><div style="font-size:30px">👤</div><div class="grow">
      <div class="bold">${esc(p.full_name || p.email)}</div><div class="small muted">${esc(p.email)}</div></div>
      <span class="badge info">${esc(ROLES[p.role] || p.role)}</span></div></div>
    <div class="menu-grid">${tiles.map((t) => `<a class="menu-tile" href="${t[0]}"><span class="ic">${t[1]}</span>${esc(t[2])}</a>`).join('')}</div>
    ${S.installEvt ? '<button class="btn primary block mt" id="mn-install">📲 Pasang aplikasi di layar utama HP</button>' : ''}
    <p class="center tiny muted mt">BTC INVENTORY v${APP_VERSION}</p>`;
  const ib = $('#mn-install');
  if (ib) ib.addEventListener('click', installApp);
}
async function installApp() {
  if (!S.installEvt) return;
  S.installEvt.prompt();
  try { await S.installEvt.userChoice; } catch (_) { /* abaikan */ }
  S.installEvt = null;
  route();
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; });
window.addEventListener('appinstalled', () => { S.installEvt = null; toast('Aplikasi terpasang.', 'ok'); });

/* ===================================================================
   Bagian 4: Dashboard, Master SKU, Akun, Pengguna
   =================================================================== */

/* ---------------------------- DASHBOARD ---------------------------- */
async function pageHome(v, ctx) {
  const today = todayStr();
  const [sum, daily, recent] = await Promise.all([
    sb.rpc('dashboard_summary').then(unwrap),
    sb.rpc('report_daily', { p_from: addDays(today, -6), p_to: today }).then(unwrap),
    sb.from('transactions').select('id,trx_no,trx_type,trx_date,party,total_qty,line_count,voided_at,created_by_name,created_at')
      .order('created_at', { ascending: false }).limit(6).then(unwrap),
  ]);
  if (ctx.token !== routeToken) return;
  const low = S.skus.filter((s) => s.is_active && s.qty_good <= Math.max(s.min_stock, 0) && s.min_stock > 0)
    .sort((a, b) => a.qty_good - b.qty_good);
  const empty = S.skus.filter((s) => s.is_active && s.qty_good === 0 && s.min_stock === 0).length;
  const maxBar = Math.max(1, ...daily.map((d) => Math.max(Number(d.in_qty), Number(d.out_qty))));
  const dayName = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

  v.innerHTML = `
    <div class="spread mb"><div><div class="bold" style="font-size:17px">Halo, ${esc((S.profile.full_name || '').split(' ')[0] || 'Admin')} 👋</div>
      <div class="small muted">${esc(fmtDate(today))} · ${esc(ROLES[S.profile.role])}</div></div></div>
    ${S.installEvt ? `<div class="card flat row"><div class="grow small"><b>Pasang di layar utama</b><br>Buka lebih cepat seperti aplikasi biasa.</div><button class="btn sm primary" id="hm-install">Pasang</button></div>` : ''}
    <div class="grid2">
      <div class="stat"><div class="lbl">Total stok bagus</div><div class="val">${fmtN(sum.good_total)}</div><div class="sub">${fmtN(sum.sku_active)} SKU aktif</div></div>
      <div class="stat dmg"><div class="lbl">Total stok rusak</div><div class="val">${fmtN(sum.damaged_total)}</div><div class="sub">terpisah dari stok bagus</div></div>
      <div class="stat in"><div class="lbl">Masuk hari ini</div><div class="val">${fmtN(sum.today_in)}</div><div class="sub">retur bagus +${fmtN(sum.today_return_good)}</div></div>
      <div class="stat out"><div class="lbl">Keluar hari ini</div><div class="val">${fmtN(sum.today_out)}</div><div class="sub">${fmtN(sum.today_trx)} transaksi hari ini</div></div>
    </div>
    <div class="grid2 mt-s">
      <a class="stat warn" href="#/sku?f=low" style="color:inherit"><div class="lbl">Stok menipis</div><div class="val">${fmtN(sum.low_count)}</div><div class="sub">di bawah stok minimum</div></a>
      <a class="stat dmg" href="#/sku?f=empty" style="color:inherit"><div class="lbl">Stok habis</div><div class="val">${fmtN(sum.empty_count)}</div><div class="sub">SKU aktif stok 0</div></a>
    </div>

    <div class="section-title">Aksi cepat</div>
    <div class="grid4">
      ${can('trx') ? `<a class="menu-tile" href="#/masuk"><span class="ic">📥</span>Masuk</a>
      <a class="menu-tile" href="#/keluar"><span class="ic">📤</span>Keluar</a>
      <a class="menu-tile" href="#/retur"><span class="ic">↩️</span>Retur</a>` : ''}
      <a class="menu-tile" href="#/opname"><span class="ic">📋</span>Opname</a>
      ${!can('trx') ? '<a class="menu-tile" href="#/kartu"><span class="ic">🗂️</span>Kartu</a><a class="menu-tile" href="#/laporan"><span class="ic">📊</span>Laporan</a><a class="menu-tile" href="#/riwayat"><span class="ic">🕘</span>Riwayat</a>' : ''}
    </div>

    <div class="section-title">7 hari terakhir <span class="small"><span class="pos">■</span> masuk &nbsp;<span class="neg">■</span> keluar</span></div>
    <div class="card"><div style="display:flex;align-items:flex-end;gap:6px;height:120px">
      ${daily.map((d) => {
        const hi = Math.round((Number(d.in_qty) / maxBar) * 100), ho = Math.round((Number(d.out_qty) / maxBar) * 100);
        const dow = dayName[new Date(String(d.day) + 'T00:00:00Z').getUTCDay()];
        return `<div style="flex:1;text-align:center;min-width:0"><div style="display:flex;align-items:flex-end;justify-content:center;gap:2px;height:96px">
          <div title="Masuk ${fmtN(d.in_qty)}" style="width:42%;height:${Math.max(hi, d.in_qty > 0 ? 4 : 1)}%;background:var(--in);border-radius:4px 4px 0 0"></div>
          <div title="Keluar ${fmtN(d.out_qty)}" style="width:42%;height:${Math.max(ho, d.out_qty > 0 ? 4 : 1)}%;background:var(--out);border-radius:4px 4px 0 0"></div></div>
          <div class="tiny muted">${dow}</div></div>`;
      }).join('')}</div>
      <div class="tiny muted mt-s">Satuan: pcs. Angka lengkap ada di menu Laporan.</div></div>

    <div class="section-title">Perlu perhatian ${low.length ? `<a href="#/sku?f=low" class="small">Lihat semua</a>` : ''}</div>
    <div class="card pad0">${low.length ? low.slice(0, 6).map((s) => `<div class="list-item" data-sku="${s.sku_id}">
      <div class="grow"><div class="t ellipsis">${esc(s.name)}</div><div class="small muted">${esc(s.sku_code)} · min ${fmtN(s.min_stock)}</div></div>
      <div class="qty-box"><div class="n ${s.qty_good === 0 ? 'neg' : ''}">${fmtN(s.qty_good)}</div>${stockBadge(s)}</div></div>`).join('')
      : emptyHtml('✅', 'Tidak ada stok yang di bawah minimum', empty ? `${empty} SKU stok 0 (belum diatur stok minimum)` : '')}</div>

    <div class="section-title">Transaksi terakhir <a href="#/riwayat" class="small">Semua</a></div>
    <div class="card pad0">${recent.length ? recent.map((t) => trxRowHtml(t)).join('') : emptyHtml('🧾', 'Belum ada transaksi')}</div>`;

  const ib = $('#hm-install'); if (ib) ib.addEventListener('click', installApp);
  $$('[data-sku]', v).forEach((el) => el.addEventListener('click', () => showSkuSheet(el.dataset.sku)));
  $$('[data-trx]', v).forEach((el) => el.addEventListener('click', () => showTrxSheet(el.dataset.trx)));
}

/* baris transaksi (dipakai dashboard & riwayat) */
function trxRowHtml(t) {
  return `<div class="list-item" data-trx="${t.id}">
    <div class="grow"><div class="row wrap" style="gap:6px">${trxBadge(t.trx_type)}${t.voided_at ? '<span class="badge gray">Dibatalkan</span>' : ''}<span class="t mono">${esc(t.trx_no)}</span></div>
      <div class="small muted ellipsis">${esc(fmtDateTime(t.created_at))}${t.party ? ' · ' + esc(t.party) : ''}${t.created_by_name ? ' · ' + esc(t.created_by_name) : ''}</div></div>
    <div class="qty-box"><div class="n" ${t.voided_at ? 'style="text-decoration:line-through;opacity:.5"' : ''}>${fmtN(t.total_qty)}</div><div class="small muted">${fmtN(t.line_count)} item</div></div></div>`;
}

/* --------------------------- MASTER SKU ---------------------------- */
async function pageSku(v, ctx) {
  const ui = S.skuUi;
  if (ctx.qs.f) { ui.filter = ctx.qs.f; ui.q = ''; ui.limit = 60; history.replaceState(null, '', '#/sku'); }
  const canEdit = can('sku_edit');
  v.innerHTML = `
    <div class="input-group"><input class="input" id="sk-q" placeholder="Cari nama / kode / barcode" value="${esc(ui.q)}" autocomplete="off">
      <button class="btn" id="sk-scan" aria-label="Pindai">📷</button></div>
    <div class="chips mt-s" id="sk-chips">${[['all', 'Semua'], ['low', 'Menipis'], ['empty', 'Habis'], ['damaged', 'Ada rusak'], ['inactive', 'Nonaktif']]
      .map(([k, t]) => `<button class="chip ${ui.filter === k ? 'on' : ''}" data-f="${k}">${t}</button>`).join('')}</div>
    <div class="spread mb"><div class="small muted" id="sk-count"></div>
      <div class="row">
        <button class="btn sm" id="sk-export">⬇ Unduh</button>
        ${canEdit ? '<button class="btn sm" id="sk-import">⬆ Impor</button><button class="btn sm primary" id="sk-add">＋ SKU</button>' : ''}
      </div></div>
    <div class="card pad0" id="sk-list"></div><div id="sk-more"></div>`;
  const filterFn = () => {
    switch (ui.filter) {
      case 'low': return (s) => s.is_active && s.min_stock > 0 && s.qty_good <= s.min_stock;
      case 'empty': return (s) => s.is_active && s.qty_good === 0;
      case 'damaged': return (s) => s.qty_damaged > 0;
      case 'inactive': return (s) => !s.is_active;
      default: return null;
    }
  };
  const draw = () => {
    if (!$('#sk-list') || !$('#sk-count')) return; // halaman sudah berganti
    const res = searchSkus(ui.q, { onlyActive: false, limit: 0, filter: filterFn() })
      .filter((s) => ui.filter === 'inactive' || ui.filter === 'all' || s.is_active || ui.filter === 'damaged');
    const shown = res.slice(0, ui.limit);
    $('#sk-count').textContent = `${fmtN(res.length)} barang`;
    $('#sk-list').innerHTML = shown.length ? shown.map((s) => `<div class="list-item" data-id="${s.sku_id}">
      <div class="grow"><div class="t ellipsis">${esc(s.name)}</div>
      <div class="small muted ellipsis">${esc(s.sku_code)}${s.category ? ' · ' + esc(s.category) : ''}${s.units_per_carton > 1 ? ' · ' + s.units_per_carton + '/dus' : ''}</div>
      <div style="margin-top:3px">${stockBadge(s)}</div></div>
      <div class="qty-box"><div class="n">${fmtN(s.qty_good)}</div><div class="small muted">${esc(s.unit)}</div>
      ${s.qty_damaged ? `<div class="d">rusak ${fmtN(s.qty_damaged)}</div>` : ''}</div></div>`).join('')
      : emptyHtml('📦', 'Tidak ada barang', canEdit ? 'Tekan "＋ SKU" untuk menambah barang, atau "⬆ Impor" dari Excel.' : '');
    $('#sk-more').innerHTML = res.length > shown.length ? `<button class="btn block" id="sk-more-btn">Tampilkan lebih banyak (${fmtN(res.length - shown.length)} lagi)</button>` : '';
    const mb = $('#sk-more-btn'); if (mb) mb.addEventListener('click', () => { ui.limit += 60; draw(); });
  };
  draw();
  $('#sk-q').addEventListener('input', debounce((e) => { ui.q = e.target.value; ui.limit = 60; draw(); }, 150));
  $('#sk-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    ui.filter = b.dataset.f; ui.limit = 60;
    $$('#sk-chips .chip').forEach((c) => c.classList.toggle('on', c === b)); draw();
  });
  $('#sk-list').addEventListener('click', (e) => { const it = e.target.closest('[data-id]'); if (it) showSkuSheet(it.dataset.id); });
  $('#sk-scan').addEventListener('click', () => openScanner({ title: 'Cari barang', single: true, onScan: (code) => {
    const hit = findByCode(code);
    if (!hit) return { ok: false, msg: 'Barcode tidak terdaftar di Master SKU.' };
    showSkuSheet(hit.sku.sku_id); return { ok: true, msg: hit.sku.name };
  } }));
  $('#sk-export').addEventListener('click', () => exportMenu('Unduh data stok', `Stok_BTC_${todayStr()}`, async () => [{
    name: 'Stok',
    rows: [['Kode SKU', 'Nama Barang', 'Kategori', 'Satuan', 'Isi per Dus', 'Barcode', 'Barcode Dus', 'Stok Minimum', 'Stok Bagus', 'Stok Rusak', 'Status'],
      ...S.skus.map((s) => [s.sku_code, s.name, s.category || '', s.unit, s.units_per_carton, s.barcode || '', s.barcode_carton || '', s.min_stock, s.qty_good, s.qty_damaged, s.is_active ? 'Aktif' : 'Nonaktif'])],
  }]));
  if (canEdit) {
    $('#sk-add').addEventListener('click', () => openSkuForm(null));
    $('#sk-import').addEventListener('click', openImportSheet);
  }
}

/* detail SKU */
function showSkuSheet(id) {
  const s = S.byId.get(id);
  if (!s) { toast('Barang tidak ditemukan.', 'err'); return; }
  openSheet(`<h2>${esc(s.name)}</h2>
    <div class="row wrap mb" style="gap:6px"><span class="badge info">${esc(s.sku_code)}</span>${stockBadge(s)}${s.category ? `<span class="badge gray">${esc(s.category)}</span>` : ''}</div>
    <div class="grid2 mb">
      <div class="stat"><div class="lbl">Stok bagus</div><div class="val">${fmtN(s.qty_good)}</div><div class="sub">${esc(dusText(s.qty_good, s) || s.unit)}</div></div>
      <div class="stat dmg"><div class="lbl">Stok rusak</div><div class="val">${fmtN(s.qty_damaged)}</div><div class="sub">${esc(dusText(s.qty_damaged, s) || s.unit)}</div></div></div>
    <div class="card flat">
      <div class="kv"><span>Satuan</span><span>${esc(s.unit)}</span></div>
      <div class="kv"><span>Isi per dus</span><span>${fmtN(s.units_per_carton)}</span></div>
      <div class="kv"><span>Stok minimum</span><span>${fmtN(s.min_stock)}</span></div>
      <div class="kv"><span>Barcode satuan</span><span>${esc(s.barcode || '-')}</span></div>
      <div class="kv"><span>Barcode dus</span><span>${esc(s.barcode_carton || '-')}</span></div></div>
    <div class="btn-row"><a class="btn primary" href="#/kartu?sku=${s.sku_id}">🗂️ Kartu Stok</a>
      ${can('sku_edit') ? '<button class="btn" id="sh-edit">✏️ Ubah</button>' : ''}</div>
    <button class="btn block ghost mt-s" data-close>Tutup</button>`, (el, api) => {
    const eb = $('#sh-edit', el);
    if (eb) eb.addEventListener('click', () => { api.close(); openSkuForm(s); });
  });
}

/* form tambah / ubah SKU */
function openSkuForm(s) {
  const isNew = !s;
  const d = s || { sku_code: '', name: '', category: '', unit: 'PCS', units_per_carton: 1, min_stock: 0, barcode: '', barcode_carton: '', is_active: true };
  const cats = [...new Set(S.skus.map((x) => x.category).filter(Boolean))].sort();
  openSheet(`<h2>${isNew ? 'Tambah SKU Baru' : 'Ubah SKU'}</h2>
    <div class="field"><label>Kode SKU *</label><input class="input" id="f-code" value="${esc(d.sku_code)}" autocapitalize="characters" autocomplete="off" ${isNew ? '' : 'readonly'}>
      ${isNew ? '' : '<div class="hint">Kode SKU tidak bisa diubah. Buat SKU baru bila perlu kode lain.</div>'}</div>
    <div class="field"><label>Nama barang *</label><input class="input" id="f-name" value="${esc(d.name)}" autocomplete="off"></div>
    <div class="grid2"><div class="field"><label>Kategori</label><input class="input" id="f-cat" list="cat-list" value="${esc(d.category || '')}" autocomplete="off">
        <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field"><label>Satuan</label><input class="input" id="f-unit" value="${esc(d.unit)}" autocapitalize="characters"></div></div>
    <div class="grid2"><div class="field"><label>Isi per dus (pcs)</label><input class="input" id="f-upc" type="number" inputmode="numeric" min="1" value="${d.units_per_carton}"></div>
      <div class="field"><label>Stok minimum</label><input class="input" id="f-min" type="number" inputmode="numeric" min="0" value="${d.min_stock}"></div></div>
    <div class="field"><label>Barcode satuan</label><div class="input-group"><input class="input" id="f-bc" inputmode="numeric" value="${esc(d.barcode || '')}" autocomplete="off"><button class="btn" id="f-bc-scan" type="button">📷</button></div></div>
    <div class="field"><label>Barcode dus / karton</label><div class="input-group"><input class="input" id="f-bcc" inputmode="numeric" value="${esc(d.barcode_carton || '')}" autocomplete="off"><button class="btn" id="f-bcc-scan" type="button">📷</button></div>
      <div class="hint">Jika diisi, memindai barcode dus otomatis menghitung satu dus penuh.</div></div>
    ${isNew ? '' : `<label class="check"><input type="checkbox" id="f-active" ${d.is_active ? 'checked' : ''}> SKU aktif (bisa dipakai transaksi)</label>`}
    <div class="err-text" id="f-err" hidden></div>
    <div class="btn-row mt"><button class="btn" data-close>Batal</button><button class="btn primary" id="f-save">Simpan</button></div>`, (el, api) => {
    const scanInto = (inputId) => () => openScanner({ title: 'Pindai barcode', single: true, onScan: (code) => { $(inputId, el).value = code; return { ok: true, msg: code }; } });
    $('#f-bc-scan', el).addEventListener('click', scanInto('#f-bc'));
    $('#f-bcc-scan', el).addEventListener('click', scanInto('#f-bcc'));
    $('#f-save', el).addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
      const err = $('#f-err', el); err.hidden = true;
      const row = {
        sku_code: $('#f-code', el).value.trim().toUpperCase(),
        name: $('#f-name', el).value.trim(),
        category: $('#f-cat', el).value.trim() || null,
        unit: $('#f-unit', el).value.trim().toUpperCase() || 'PCS',
        units_per_carton: intOr($('#f-upc', el).value, 1),
        min_stock: intOr($('#f-min', el).value, 0),
        barcode: $('#f-bc', el).value.trim() || null,
        barcode_carton: $('#f-bcc', el).value.trim() || null,
      };
      if (!row.sku_code || !row.name) { err.hidden = false; err.textContent = 'Kode SKU dan nama barang wajib diisi.'; return; }
      if (row.units_per_carton < 1) { err.hidden = false; err.textContent = 'Isi per dus minimal 1.'; return; }
      if (row.min_stock < 0) { err.hidden = false; err.textContent = 'Stok minimum tidak boleh negatif.'; return; }
      try {
        if (isNew) unwrap(await sb.from('skus').insert(row));
        else { row.is_active = $('#f-active', el).checked; delete row.sku_code; unwrap(await sb.from('skus').update(row).eq('id', s.sku_id)); }
        await loadSkus(true);
        api.close(); toast(isNew ? 'SKU ditambahkan.' : 'SKU diperbarui.', 'ok');
        route();
      } catch (e) { err.hidden = false; err.textContent = errMsg(e); }
    }));
  });
}

/* ------------------------ IMPOR SKU (Excel/CSV) ------------------------ */
const IMPORT_HEAD = ['Kode SKU', 'Nama Barang', 'Kategori', 'Satuan', 'Isi per Dus', 'Barcode', 'Barcode Dus', 'Stok Minimum'];
function openImportSheet() {
  openSheet(`<h2>Impor SKU dari Excel / CSV</h2>
    <ol class="small" style="padding-left:18px;margin-top:0">
      <li>Unduh contoh file, isi daftar barang Anda.</li>
      <li>Pilih file yang sudah diisi di bawah ini.</li>
      <li>Periksa pratinjau, lalu tekan Impor.</li></ol>
    <p class="small muted">Kode SKU yang sudah ada akan diperbarui datanya (stok tidak berubah). Stok awal dimasukkan lewat Barang Masuk atau Stock Opname.</p>
    <button class="btn block" id="im-tpl">⬇ Unduh contoh file</button>
    <label class="btn primary block mt-s">Pilih file (.xlsx / .csv)<input type="file" id="im-file" accept=".xlsx,.xls,.csv,text/csv" hidden></label>
    <div id="im-prev" class="mt"></div>
    <button class="btn block ghost mt-s" data-close>Tutup</button>`, (el, api) => {
    let changed = false;
    api.onClose = () => { if (changed) route(true); };
    $('#im-tpl', el).addEventListener('click', () => exportXlsx('Contoh_Impor_SKU', [{ name: 'SKU', rows: [IMPORT_HEAD,
      ['SKU-001', 'Indomie Goreng 85g', 'Mie Instan', 'PCS', 40, '8991111111111', '18991111111118', 100],
      ['SKU-002', 'Aqua 600ml', 'Minuman', 'PCS', 24, '8992222222222', '', 48]] }]));
    $('#im-file', el).addEventListener('change', async (ev) => {
      const f = ev.target.files && ev.target.files[0]; if (!f) return;
      const box = $('#im-prev', el);
      try {
        const rows = await readSkuFile(f);
        if (!rows.length) { box.innerHTML = '<div class="err-text">Tidak ada baris data yang terbaca. Pastikan baris pertama berisi judul kolom (Kode SKU, Nama Barang, …).</div>'; return; }
        const bad = rows.filter((r) => !r.sku_code || !r.name).length;
        box.innerHTML = `<div class="card flat"><b>${fmtN(rows.length)}</b> baris terbaca${bad ? `, <span class="neg">${bad} baris tidak lengkap (akan dilewati & dilaporkan)</span>` : ''}.
          <div class="table-wrap mt-s" style="box-shadow:none"><table class="tbl"><tr><th class="l">Kode</th><th class="l">Nama</th><th>Isi/dus</th><th>Min</th></tr>
          ${rows.slice(0, 5).map((r) => `<tr><td>${esc(r.sku_code)}</td><td class="l">${esc(r.name)}</td><td>${esc(r.units_per_carton ?? '')}</td><td>${esc(r.min_stock ?? '')}</td></tr>`).join('')}</table></div>
          ${rows.length > 5 ? `<div class="tiny muted">…dan ${rows.length - 5} baris lainnya</div>` : ''}</div>
          <button class="btn primary block" id="im-go">Impor ${fmtN(rows.length)} baris</button><div id="im-res"></div>`;
        $('#im-go', el).addEventListener('click', (e2) => withBusy(e2.currentTarget, async () => {
          let ins = 0, upd = 0, errors = [];
          try {
            for (let i = 0; i < rows.length; i += 200) {
              const chunk = rows.slice(i, i + 200);
              const r = unwrap(await sb.rpc('import_skus', { p_rows: chunk }));
              ins += r.inserted; upd += r.updated;
              (r.errors || []).forEach((x) => errors.push({ ...x, row: x.row + i }));
            }
          } catch (e) { toastErr(e); return; }
          await loadSkus(true);
          changed = true;
          $('#im-res', el).innerHTML = `<div class="card flat mt"><b>Selesai.</b> Baru: ${ins}, diperbarui: ${upd}, gagal: ${errors.length}.
            ${errors.length ? `<div class="small neg mt-s">${errors.slice(0, 12).map((x) => `Baris ${x.row} (${esc(x.code || '-')}): ${esc(errMsg({ message: x.error }))}`).join('<br>')}${errors.length > 12 ? '<br>…' : ''}</div>` : ''}</div>`;
          $('#im-go', el).hidden = true;
        }));
      } catch (e) { box.innerHTML = `<div class="err-text">Gagal membaca file: ${esc(errMsg(e))}</div>`; }
    });
  });
}
const HEAD_ALIAS = {
  sku_code: ['kode sku', 'sku', 'sku_code', 'kode', 'kode barang', 'sku code'],
  name: ['nama barang', 'nama', 'name', 'nama produk', 'deskripsi', 'barang'],
  category: ['kategori', 'category'],
  unit: ['satuan', 'unit', 'uom'],
  units_per_carton: ['isi per dus', 'isi/dus', 'isi', 'pcs per dus', 'isi per karton', 'units_per_carton', 'isi dus'],
  barcode: ['barcode', 'barcode satuan', 'ean', 'barcode pcs'],
  barcode_carton: ['barcode dus', 'barcode karton', 'barcode_carton', 'ean dus'],
  min_stock: ['stok minimum', 'stok minimal', 'min stok', 'min_stock', 'minimum', 'stok min'],
};
const cellText = (v) => (v === null || v === undefined ? '' : (typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : String(v).trim()));
async function readSheetRows(file) {
  if (typeof XLSX === 'undefined') throw new Error('Pustaka Excel belum termuat. Muat ulang halaman.');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', raw: true, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}
async function readSkuFile(file) {
  const aoa = await readSheetRows(file);
  if (aoa.length < 2) return [];
  const head = aoa[0].map((h) => String(h).trim().toLowerCase());
  const idx = {};
  for (const [key, aliases] of Object.entries(HEAD_ALIAS)) idx[key] = head.findIndex((h) => aliases.includes(h));
  if (idx.sku_code < 0 || idx.name < 0) throw new Error('Kolom "Kode SKU" dan "Nama Barang" tidak ditemukan di baris pertama.');
  const out = [];
  for (const r of aoa.slice(1)) {
    if (r.every((c) => cellText(c) === '')) continue;
    const g = (k) => (idx[k] >= 0 ? cellText(r[idx[k]]) : '');
    const row = { sku_code: g('sku_code'), name: g('name') };
    ['category', 'unit', 'barcode', 'barcode_carton'].forEach((k) => { const x = g(k); if (x) row[k] = x; });
    ['units_per_carton', 'min_stock'].forEach((k) => { const x = g(k); if (x !== '') row[k] = String(intOr(x, k === 'units_per_carton' ? 1 : 0)); });
    out.push(row);
  }
  return out;
}

/* ------------------------------ AKUN SAYA ------------------------------ */
async function pageAkun(v) {
  const p = S.profile;
  v.innerHTML = `<div class="card"><h2>Profil</h2>
      <div class="field"><label>Nama tampilan</label><div class="input-group"><input class="input" id="ak-name" value="${esc(p.full_name || '')}"><button class="btn primary" id="ak-save">Simpan</button></div></div>
      <div class="kv"><span>Email</span><span>${esc(p.email)}</span></div>
      <div class="kv"><span>Peran</span><span>${esc(ROLES[p.role])}</span></div></div>
    <div class="card"><h2>Ganti kata sandi</h2>
      <div class="field"><input class="input" id="ak-pw" type="password" placeholder="Kata sandi baru (min. 6 karakter)" autocomplete="new-password"></div>
      <button class="btn block" id="ak-pwgo">Ganti kata sandi</button></div>
    <div class="card"><h2>Aplikasi</h2>
      <div class="kv"><span>Versi</span><span>${APP_VERSION}</span></div>
      <div class="kv"><span>Koneksi</span><span>${navigator.onLine ? 'Online' : 'Offline'}</span></div>
      ${S.installEvt ? '<button class="btn primary block mt-s" id="ak-install">📲 Pasang aplikasi</button>' : ''}
      <button class="btn block mt-s" id="ak-reload">Muat ulang aplikasi (ambil versi terbaru)</button></div>
    <button class="btn danger block" id="ak-out">Keluar</button>`;
  $('#ak-save').addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
    try { unwrap(await sb.rpc('set_my_name', { p_name: $('#ak-name').value })); await loadProfile(); toast('Nama disimpan.', 'ok'); } catch (e) { toastErr(e); }
  }));
  $('#ak-pwgo').addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
    const pw = $('#ak-pw').value;
    if (pw.length < 6) { toast('Kata sandi minimal 6 karakter.', 'err'); return; }
    try { const r = await sb.auth.updateUser({ password: pw }); if (r.error) throw r.error; $('#ak-pw').value = ''; toast('Kata sandi diganti.', 'ok'); } catch (e) { toastErr(e); }
  }));
  const ib = $('#ak-install'); if (ib) ib.addEventListener('click', installApp);
  $('#ak-reload').addEventListener('click', async () => {
    try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } catch (_) { /* abaikan */ }
    location.reload();
  });
  $('#ak-out').addEventListener('click', async () => { if (await confirmBox({ title: 'Keluar?', text: 'Anda akan keluar dari aplikasi.', ok: 'Keluar', danger: true })) doLogout(); });
}

/* ------------------------------- PENGGUNA ------------------------------ */
async function pagePengguna(v) {
  if (!can('users')) { v.innerHTML = emptyHtml('🔒', 'Hanya Admin yang dapat membuka halaman ini'); return; }
  const users = unwrap(await sb.from('profiles').select('*').order('created_at'));
  const pending = users.filter((u) => !u.is_active);
  v.innerHTML = `${pending.length ? `<div class="card flat" style="background:var(--ret-soft)"><b>${pending.length} akun menunggu persetujuan.</b> Ketuk akun lalu atur peran & aktifkan.</div>` : ''}
    <div class="card pad0">${users.map((u) => `<div class="list-item" data-u="${u.id}">
      <div class="grow"><div class="t ellipsis">${esc(u.full_name || u.email)}</div><div class="small muted ellipsis">${esc(u.email)}</div></div>
      <div style="text-align:right"><span class="badge info">${esc(ROLES[u.role] || u.role).split(' ')[0]}</span><br>${u.is_active ? '<span class="badge green">Aktif</span>' : '<span class="badge amber">Menunggu</span>'}</div></div>`).join('')}</div>
    <div class="card flat small"><b>Hak akses</b><br>
      <b>Admin</b>: semua fitur + kelola pengguna.<br><b>Supervisor</b>: semua transaksi, master SKU, finalisasi opname, pembatalan.<br>
      <b>Staff Gudang</b>: barang masuk/keluar, retur, hitung opname.<br><b>Viewer</b>: hanya melihat stok & laporan.</div>`;
  $$('[data-u]', v).forEach((el) => el.addEventListener('click', () => {
    const u = users.find((x) => x.id === el.dataset.u);
    const self = u.id === S.profile.id;
    openSheet(`<h2>${esc(u.full_name || u.email)}</h2><p class="small muted">${esc(u.email)}</p>
      ${self ? '<div class="card flat small">Ini akun Anda sendiri; peran tidak bisa diubah dari sini.</div>' : `
      <div class="field"><label>Peran</label><select class="select" id="us-role">${Object.entries(ROLES).map(([k, t]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" id="us-act" checked> Akun aktif (hilangkan centang untuk menonaktifkan)</label>
      <div class="btn-row mt"><button class="btn" data-close>Batal</button><button class="btn primary" id="us-save">Simpan</button></div>`}
      ${self ? '<button class="btn block mt" data-close>Tutup</button>' : ''}`, (sheet, api) => {
      const sv = $('#us-save', sheet); if (!sv) return;
      sv.addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
        try { unwrap(await sb.rpc('admin_set_user', { p_user_id: u.id, p_role: $('#us-role', sheet).value, p_active: $('#us-act', sheet).checked })); api.close(); toast('Pengguna diperbarui.', 'ok'); route(true); } catch (e) { toastErr(e); }
      }));
    });
  }));
}

/* ===================================================================
   Bagian 5: form transaksi (masuk / keluar / retur), riwayat, pembatalan
   =================================================================== */

function getForm(type) {
  if (!S.forms[type]) S.forms[type] = { items: [], ref: '', party: '', notes: '', clientRef: uuid(), busy: false };
  return S.forms[type];
}
const itemQtyShown = (it) => (it.mode === 'dus' ? it.qty / it.upc : it.qty);

/* tambah barang ke form (dari pencarian atau hasil scan) */
function addItemToForm(f, sku, factor = 1, via = '') {
  let it = f.items.find((x) => x.sku_id === sku.sku_id);
  if (!it) {
    it = { sku_id: sku.sku_id, qty: 0, upc: sku.units_per_carton || 1, mode: via === 'dus' ? 'dus' : 'pcs' };
    f.items.push(it);
  }
  it.qty += factor;
  if (it.mode === 'dus' && it.qty % it.upc !== 0) it.mode = 'pcs';
  return it;
}

async function pageTrxForm(v, type) {
  const T = TRX[type];
  const isDispose = type === 'dispose_damaged';
  if (!can(isDispose ? 'dispose' : 'trx')) {
    v.innerHTML = emptyHtml('🔒', 'Peran Anda hanya bisa melihat data', 'Hubungi Admin bila perlu akses mencatat transaksi.');
    return;
  }
  const f = getForm(type);
  v.classList.add('has-bar');
  const stockOf = (s) => (T.bucket === 'good' ? s.qty_good : s.qty_damaged);
  const dirty = () => { f.dirtyAt = Date.now(); };

  v.innerHTML = `
    <div class="hero ${T.hero}"><h2>${esc(T.label)}</h2><p>${esc(T.desc)}</p></div>
    <div class="card">
      <div class="grid2">
        <div class="field"><label>${esc(T.ref)}</label><input class="input" id="tf-ref" value="${esc(f.ref)}" autocomplete="off"></div>
        <div class="field"><label>${esc(T.party)}</label><input class="input" id="tf-party" value="${esc(f.party)}" autocomplete="off"></div>
      </div>
      <div class="field" style="margin-bottom:0"><label>Catatan (opsional)</label><input class="input" id="tf-notes" value="${esc(f.notes)}" autocomplete="off"></div>
    </div>
    <div class="row mb"><button class="btn primary grow" id="tf-scan">📷 Pindai Barcode</button><button class="btn grow" id="tf-add">🔎 Cari Barang</button></div>
    <div id="tf-items"></div>
    <div class="sticky-bar"><div class="sum" id="tf-sum"></div><button class="btn primary" id="tf-save">Simpan</button></div>`;

  const bind = (id, key) => $(id, v).addEventListener('input', (e) => { f[key] = e.target.value; dirty(); });
  bind('#tf-ref', 'ref'); bind('#tf-party', 'party'); bind('#tf-notes', 'notes');

  const draw = () => {
    const box = $('#tf-items', v);
    if (!f.items.length) {
      box.innerHTML = emptyHtml('🧺', 'Belum ada barang', 'Pindai barcode atau cari barang untuk ditambahkan.');
    } else {
      box.innerHTML = f.items.map((it, i) => {
        const s = S.byId.get(it.sku_id);
        if (!s) return '';
        const cur = stockOf(s);
        const after = cur + T.sign * it.qty;
        const bad = after < 0;
        return `<div class="item" data-i="${i}">
          <div class="spread"><div class="grow"><div class="t bold ellipsis">${esc(s.name)}</div>
            <div class="small muted">${esc(s.sku_code)} · stok ${T.bucket === 'good' ? 'bagus' : 'rusak'} saat ini <b>${fmtN(cur)}</b> ${esc(s.unit)}</div></div>
            <button class="x" data-act="del" aria-label="Hapus">✕</button></div>
          <div class="qty-row">
            <button class="step" data-act="dec" aria-label="Kurangi">−</button>
            <input class="input" data-act="qty" type="number" inputmode="numeric" min="1" value="${itemQtyShown(it)}">
            <button class="step" data-act="inc" aria-label="Tambah">＋</button>
            ${it.upc > 1 ? `<button class="mode-btn" data-act="mode">${it.mode === 'dus' ? 'DUS' : esc(s.unit)}</button>` : `<span class="small muted" style="min-width:44px;text-align:center">${esc(s.unit)}</span>`}
          </div>
          <div class="after">${it.mode === 'dus' ? `= <b>${fmtN(it.qty)}</b> ${esc(s.unit)} (${it.upc}/dus) · ` : (it.upc > 1 && it.qty >= it.upc ? `= ${esc(dusText(it.qty, s))} · ` : '')}
            Stok setelahnya: <b class="${bad ? 'bad' : 'ok'}">${fmtN(after)}</b>${bad ? ' — <b class="bad">melebihi stok!</b>' : ''}</div></div>`;
      }).join('');
    }
    const total = f.items.reduce((a, b) => a + b.qty, 0);
    const over = f.items.some((it) => { const s = S.byId.get(it.sku_id); return s && stockOf(s) + T.sign * it.qty < 0; });
    $('#tf-sum', v).innerHTML = `<b>${fmtN(f.items.length)}</b> barang · <b>${fmtN(total)}</b> pcs${over ? '<div class="neg tiny">Ada barang melebihi stok</div>' : ''}`;
    $('#tf-save', v).disabled = !f.items.length || over || f.busy;
  };

  const addSku = (sku, factor, via) => { addItemToForm(f, sku, factor, via); dirty(); draw(); };

  $('#tf-items', v).addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]'); if (!row) return;
    const it = f.items[Number(row.dataset.i)];
    const act = e.target.dataset.act; if (!act || act === 'qty') return;
    const stepSize = it.mode === 'dus' ? it.upc : 1;
    if (act === 'del') f.items.splice(Number(row.dataset.i), 1);
    if (act === 'inc') it.qty += stepSize;
    if (act === 'dec') it.qty = Math.max(stepSize, it.qty - stepSize);
    if (act === 'mode') {
      if (it.mode === 'pcs') {
        if (it.qty % it.upc !== 0) { toast(`Jumlah ${fmtN(it.qty)} belum pas per dus (isi ${it.upc}).`, 'err'); return; }
        it.mode = 'dus';
      } else it.mode = 'pcs';
    }
    dirty(); draw();
  });
  $('#tf-items', v).addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'qty') return;
    const row = e.target.closest('[data-i]');
    const it = f.items[Number(row.dataset.i)];
    const n = Math.max(1, intOr(e.target.value, 1));
    it.qty = it.mode === 'dus' ? n * it.upc : n;
    dirty(); draw();
  });

  $('#tf-add', v).addEventListener('click', () => openSkuPicker({
    title: 'Tambah barang', onlyActive: true, showStock: T.bucket,
    filter: T.sign < 0 ? (s) => stockOf(s) > 0 : null,
    onPick: (s, hit) => addSku(s, hit.factor || 1, hit.via),
  }));
  $('#tf-scan', v).addEventListener('click', () => openScanner({
    title: `Pindai: ${T.label}`, hint: 'Pindai barang satu per satu. Barcode dus = 1 dus penuh.',
    onScan: (code) => {
      const hit = findByCode(code);
      if (!hit) return { ok: false, msg: 'Barcode tidak terdaftar di Master SKU.' };
      if (!hit.sku.is_active) return { ok: false, msg: `${hit.sku.name} sudah nonaktif.` };
      if (T.sign < 0 && stockOf(hit.sku) <= 0) return { ok: false, msg: `${hit.sku.name}: stok ${T.bucket === 'good' ? 'bagus' : 'rusak'} kosong.` };
      addSku(hit.sku, hit.factor, hit.via);
      const it = f.items.find((x) => x.sku_id === hit.sku.sku_id);
      return { ok: true, msg: `${hit.sku.name} → ${fmtN(it.qty)} ${hit.sku.unit}` };
    },
  }));

  $('#tf-save', v).addEventListener('click', async (ev) => {
    const btn = ev.currentTarget; // ambil sekarang: setelah await nilainya hilang
    if (f.busy) return;
    if (!navigator.onLine) { toast('Tidak ada koneksi internet. Coba lagi saat tersambung.', 'err'); return; }
    const lines = f.items.map((it) => { const s = S.byId.get(it.sku_id); return `• ${s.name}: ${fmtN(it.qty)} ${s.unit}`; });
    const total = f.items.reduce((a, b) => a + b.qty, 0);
    const okc = await confirmBox({
      title: `Simpan ${T.label}?`, ok: 'Ya, Simpan',
      html: `<p class="small" style="margin-bottom:8px">${f.items.length} barang · total ${fmtN(total)} pcs${f.party ? '<br>' + esc(T.party) + ': ' + esc(f.party) : ''}</p>
        <div class="card flat small" style="max-height:34vh;overflow:auto;white-space:pre-line">${esc(lines.join('\n'))}</div>
        <p class="tiny muted">Transaksi yang sudah disimpan tidak dapat diubah, hanya dapat dibatalkan oleh Supervisor/Admin.</p>`,
    });
    if (!okc) return;
    f.busy = true; draw();
    const old = btn.innerHTML; btn.innerHTML = '<span class="spinner sm"></span> Menyimpan…';
    try {
      const res = unwrap(await sb.rpc('post_transaction', {
        p_type: type, p_reference: f.ref, p_party: f.party, p_notes: f.notes,
        p_items: f.items.map((it) => ({ sku_id: it.sku_id, qty: it.qty })), p_client_ref: f.clientRef,
      }));
      delete S.forms[type];
      await loadSkus(true).catch(() => {});
      showTrxDone(res, T, type);
    } catch (e) {
      f.busy = false;
      if (isNetworkErr(e)) {
        toast('Koneksi terputus. Tekan Simpan lagi; jika transaksi sudah masuk, tidak akan tercatat dobel.', 'err', 6500);
      } else {
        toastErr(e);
        await loadSkus(true).catch(() => {});
      }
      btn.innerHTML = old; draw();
    }
  });
  draw();
}

function showTrxDone(res, T, type) {
  openSheet(`<div class="center"><div style="font-size:46px">${res.duplicate ? 'ℹ️' : '✅'}</div>
    <h2>${res.duplicate ? 'Sudah tercatat sebelumnya' : 'Transaksi tersimpan'}</h2>
    <div class="badge info" style="font-size:14px;padding:4px 12px">${esc(res.trx_no)}</div>
    <p class="small muted mt-s">${res.duplicate ? 'Transaksi ini sudah masuk sebelumnya (tidak dicatat dobel).' : `${esc(T.label)}: ${fmtN(res.lines)} barang, total ${fmtN(res.total_qty)} pcs.`}</p></div>
    <div class="btn-row mt"><a class="btn" href="#/riwayat">Lihat Riwayat</a><button class="btn primary" id="td-new">Transaksi Baru</button></div>`, (el, api) => {
    $('#td-new', el).addEventListener('click', () => { api.close(); route(true); });
  });
  // tampilan form dikosongkan di belakang
  const view = $('#view'); if (view) { view.classList.remove('has-bar'); }
}

/* ---------------------------- HALAMAN RETUR ---------------------------- */
async function pageRetur(v, ctx) {
  const tab = S.returTab || 'return_good';
  const tabs = [['return_good', 'Retur Bagus'], ['return_damaged', 'Retur Rusak']];
  if (can('dispose')) tabs.push(['dispose_damaged', 'Keluarkan Rusak']);
  if (!can('trx')) { v.innerHTML = emptyHtml('🔒', 'Peran Anda hanya bisa melihat data'); return; }
  const cur = tabs.some((t) => t[0] === tab) ? tab : 'return_good';
  v.innerHTML = `<div class="tabs" id="rt-tabs">${tabs.map(([k, t]) => `<button data-t="${k}" class="${k === cur ? 'on' : ''}">${t}</button>`).join('')}</div><div id="rt-body"></div>`;
  $('#rt-tabs', v).addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; S.returTab = b.dataset.t; route(); });
  const body = $('#rt-body', v);
  await pageTrxForm(body, cur);
  // kelas has-bar ada di elemen body; pindahkan ke #view agar jarak bawah cukup
  if (body.classList.contains('has-bar')) { v.classList.add('has-bar'); }
}

/* ----------------------------- RIWAYAT ------------------------------- */
async function pageRiwayat(v, ctx) {
  if (!S.hist) S.hist = { from: addDays(todayStr(), -6), to: todayStr(), type: 'all', q: '', rows: [], done: false };
  const h = S.hist;
  const types = [['all', 'Semua'], ['inbound', 'Masuk'], ['outbound', 'Keluar'], ['return_good', 'Retur Bagus'], ['return_damaged', 'Retur Rusak'], ['dispose_damaged', 'Rusak Keluar'], ['opname', 'Opname'], ['void', 'Pembatalan']];
  v.innerHTML = `
    <div class="card"><div class="grid2">
      <div class="field" style="margin:0"><label>Dari</label><input class="input" type="date" id="rw-from" value="${h.from}"></div>
      <div class="field" style="margin:0"><label>Sampai</label><input class="input" type="date" id="rw-to" value="${h.to}"></div></div>
      <div class="row wrap mt-s" style="gap:6px">
        <button class="chip" data-p="0">Hari ini</button><button class="chip" data-p="6">7 hari</button><button class="chip" data-p="29">30 hari</button><button class="chip" data-p="m">Bulan ini</button></div>
      <input class="input mt-s" id="rw-q" placeholder="Cari no. transaksi / referensi / pihak" value="${esc(h.q)}" autocomplete="off"></div>
    <div class="chips" id="rw-chips">${types.map(([k, t]) => `<button class="chip ${h.type === k ? 'on' : ''}" data-ty="${k}">${t}</button>`).join('')}</div>
    <div class="spread mb"><div class="small muted" id="rw-count"></div><button class="btn sm" id="rw-export">⬇ Unduh rincian</button></div>
    <div class="card pad0" id="rw-list"></div><div id="rw-more" class="mt-s"></div>`;

  const clean = (s) => s.replace(/[,()%*\\]/g, ' ').trim();
  const load = async (reset) => {
    if (reset) { h.rows = []; h.done = false; }
    const list = $('#rw-list', v);
    if (reset) list.innerHTML = loadingHtml();
    try {
      let q = sb.from('transactions').select('id,trx_no,trx_type,trx_date,reference_no,party,total_qty,line_count,voided_at,created_by_name,created_at')
        .gte('trx_date', h.from).lte('trx_date', h.to).order('created_at', { ascending: false }).range(h.rows.length, h.rows.length + 39);
      if (h.type !== 'all') q = q.eq('trx_type', h.type);
      const qq = clean(h.q);
      if (qq) q = q.or(`trx_no.ilike.%${qq}%,reference_no.ilike.%${qq}%,party.ilike.%${qq}%`);
      const data = unwrap(await q);
      h.rows = h.rows.concat(data);
      h.done = data.length < 40;
    } catch (e) { list.innerHTML = `<div class="err-text" style="padding:12px">${esc(errMsg(e))}</div>`; return; }
    list.innerHTML = h.rows.length ? h.rows.map(trxRowHtml).join('') : emptyHtml('🧾', 'Tidak ada transaksi pada filter ini');
    $('#rw-count', v).textContent = `${fmtN(h.rows.length)}${h.done ? '' : '+'} transaksi`;
    $('#rw-more', v).innerHTML = h.done ? '' : '<button class="btn block" id="rw-more-btn">Muat lagi</button>';
    const mb = $('#rw-more-btn', v); if (mb) mb.addEventListener('click', (e) => withBusy(e.currentTarget, () => load(false)));
  };
  const setRange = (a, b) => { h.from = a; h.to = b; $('#rw-from', v).value = a; $('#rw-to', v).value = b; load(true); };
  $('#rw-from', v).addEventListener('change', (e) => { if (e.target.value) { h.from = e.target.value; if (h.to < h.from) { h.to = h.from; $('#rw-to', v).value = h.to; } load(true); } });
  $('#rw-to', v).addEventListener('change', (e) => { if (e.target.value) { h.to = e.target.value; if (h.from > h.to) { h.from = h.to; $('#rw-from', v).value = h.from; } load(true); } });
  $$('[data-p]', v).forEach((b) => b.addEventListener('click', () => {
    const t = todayStr();
    if (b.dataset.p === 'm') setRange(t.slice(0, 8) + '01', t); else setRange(addDays(t, -Number(b.dataset.p)), t);
  }));
  $('#rw-q', v).addEventListener('input', debounce((e) => { h.q = e.target.value; load(true); }, 350));
  $('#rw-chips', v).addEventListener('click', (e) => {
    const b = e.target.closest('[data-ty]'); if (!b) return;
    h.type = b.dataset.ty; $$('#rw-chips .chip', v).forEach((c) => c.classList.toggle('on', c === b)); load(true);
  });
  $('#rw-list', v).addEventListener('click', (e) => { const it = e.target.closest('[data-trx]'); if (it) showTrxSheet(it.dataset.trx); });
  $('#rw-export', v).addEventListener('click', () => exportMenu('Unduh rincian transaksi', `Riwayat_${h.from}_sd_${h.to}`, async () => {
    const mv = await fetchAll(() => {
      let q = sb.from('stock_movements')
        .select('id,trx_date,trx_type,bucket,qty_change,balance_after,created_at,transactions(trx_no,reference_no,party,notes,created_by_name,voided_at),skus(sku_code,name,unit)')
        .gte('trx_date', h.from).lte('trx_date', h.to).order('id');
      if (h.type !== 'all') q = q.eq('trx_type', h.type);
      return q;
    });
    const rows = [['Tanggal', 'Jam (WIB)', 'No. Transaksi', 'Jenis', 'Referensi', 'Pihak', 'Kode SKU', 'Nama Barang', 'Satuan', 'Stok', 'Jumlah (+/-)', 'Saldo Setelah', 'Dicatat Oleh', 'Status', 'Catatan'],
      ...mv.map((m) => [fmtDate(m.trx_date), new Date(m.created_at).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
        m.transactions?.trx_no || '', (TRX[m.trx_type] || {}).label || m.trx_type, m.transactions?.reference_no || '', m.transactions?.party || '',
        m.skus?.sku_code || '', m.skus?.name || '', m.skus?.unit || '', BUCKET[m.bucket], m.qty_change, m.balance_after,
        m.transactions?.created_by_name || '', m.transactions?.voided_at ? 'Dibatalkan' : '', m.transactions?.notes || ''])];
    return [{ name: 'Riwayat', rows }];
  }));
  await load(h.rows.length === 0);
  if (h.rows.length) {
    $('#rw-list', v).innerHTML = h.rows.map(trxRowHtml).join('');
    $('#rw-count', v).textContent = `${fmtN(h.rows.length)}${h.done ? '' : '+'} transaksi`;
  }
}

/* ------------------------- DETAIL TRANSAKSI --------------------------- */
async function showTrxSheet(id) {
  const api = openSheet(`<div class="center">${loadingHtml()}</div>`);
  try {
    const [t, mv] = await Promise.all([
      sb.from('transactions').select('*').eq('id', id).single().then(unwrap),
      sb.from('stock_movements').select('id,bucket,qty_change,balance_after,skus(sku_code,name,unit)').eq('transaction_id', id).order('id').then(unwrap),
    ]);
    const T = TRX[t.trx_type] || {};
    const canVoid = can('void') && !t.voided_at && !['opname', 'void'].includes(t.trx_type);
    api.el.innerHTML = `<div class="sheet-grip"></div><h2>${esc(t.trx_no)}</h2>
      <div class="row wrap mb" style="gap:6px">${trxBadge(t.trx_type)}${t.voided_at ? '<span class="badge gray">Dibatalkan</span>' : ''}</div>
      <div class="card flat">
        <div class="kv"><span>Tanggal</span><span>${esc(fmtDate(t.trx_date))}</span></div>
        <div class="kv"><span>Dicatat</span><span>${esc(fmtDateTime(t.created_at))}</span></div>
        <div class="kv"><span>Oleh</span><span>${esc(t.created_by_name || '-')}</span></div>
        ${t.reference_no ? `<div class="kv"><span>${t.trx_type === 'void' ? 'Membatalkan' : 'Referensi'}</span><span>${esc(t.reference_no)}</span></div>` : ''}
        ${t.party ? `<div class="kv"><span>Pihak</span><span>${esc(t.party)}</span></div>` : ''}
        ${t.notes ? `<div class="kv"><span>${t.trx_type === 'void' ? 'Alasan' : 'Catatan'}</span><span>${esc(t.notes)}</span></div>` : ''}
        ${t.voided_at ? `<div class="kv"><span>Dibatalkan</span><span>${esc(fmtDateTime(t.voided_at))} oleh ${esc(t.voided_by_name || '-')}<br>Alasan: ${esc(t.void_reason || '-')}</span></div>` : ''}</div>
      <div class="table-wrap"><table class="tbl"><tr><th>Barang</th><th>Stok</th><th>+/−</th><th>Saldo</th></tr>
        ${mv.map((m) => `<tr><td title="${esc(m.skus?.name)}">${esc(m.skus?.name || '-')}<div class="tiny muted">${esc(m.skus?.sku_code || '')}</div></td><td>${BUCKET[m.bucket]}</td>
          <td class="${m.qty_change > 0 ? 'pos' : 'neg'}">${m.qty_change > 0 ? '+' : ''}${fmtN(m.qty_change)}</td><td>${fmtN(m.balance_after)}</td></tr>`).join('')}</table></div>
      ${canVoid ? '<button class="btn danger block" id="tx-void">Batalkan transaksi ini</button>' : ''}
      <button class="btn block ghost mt-s" data-close>Tutup</button>`;
    $$('[data-close]', api.el).forEach((b) => b.addEventListener('click', () => api.close()));
    const vb = $('#tx-void', api.el);
    if (vb) vb.addEventListener('click', async () => {
      const reason = await promptBox({ title: 'Batalkan transaksi?', label: 'Alasan pembatalan (wajib)', placeholder: 'Contoh: salah input jumlah', ok: 'Batalkan Transaksi', danger: true, minLen: 3 });
      if (!reason) return;
      await withBusy(vb, async () => {
        try {
          const r = unwrap(await sb.rpc('void_transaction', { p_trx_id: id, p_reason: reason }));
          api.close(); await loadSkus(true); toast(`Dibatalkan (${r.trx_no}). Stok dikembalikan.`, 'ok', 4500); route(true);
        } catch (e) { toastErr(e); }
      });
    });
  } catch (e) {
    api.el.innerHTML = `<div class="sheet-grip"></div><div class="err-text">${esc(errMsg(e))}</div><button class="btn block mt" data-close>Tutup</button>`;
    $$('[data-close]', api.el).forEach((b) => b.addEventListener('click', () => api.close()));
  }
}

/* ===================================================================
   Bagian 6: Stock Opname, Kartu Stok, Laporan harian & bulanan
   =================================================================== */

/* ----------------------------- STOCK OPNAME ----------------------------- */
const OP_STATUS = { draft: ['Sedang dihitung', 'amber'], final: ['Selesai', 'green'], cancelled: ['Dibatalkan', 'gray'] };

async function pageOpname(v) {
  const list = unwrap(await sb.from('stock_opnames').select('*').order('created_at', { ascending: false }).limit(40));
  const canCount = can('opname_count');
  v.innerHTML = `
    <div class="card flat small">Stock opname = mencocokkan stok sistem dengan hitungan fisik. Hanya barang yang <b>Anda hitung</b> yang disesuaikan saat opname diselesaikan oleh Supervisor/Admin.</div>
    ${canCount ? '<button class="btn primary block mb" id="op-new">＋ Mulai Opname Baru</button>' : ''}
    <div class="card pad0">${list.length ? list.map((o) => `<a class="list-item" href="#/opname/${o.id}">
      <div class="grow"><div class="t mono">${esc(o.opname_no)}</div><div class="small muted ellipsis">${esc(fmtDate(o.opname_date))} · ${esc(o.created_by_name || '')}${o.notes ? ' · ' + esc(o.notes) : ''}</div></div>
      <span class="badge ${OP_STATUS[o.status][1]}">${OP_STATUS[o.status][0]}</span></a>`).join('')
      : emptyHtml('📋', 'Belum ada opname')}</div>`;
  const nb = $('#op-new', v);
  if (nb) nb.addEventListener('click', async () => {
    const notes = await promptBox({ title: 'Opname baru', label: 'Catatan (mis. "Opname akhir bulan", boleh kosong)', ok: 'Mulai' });
    if (notes === null) return;
    try {
      const r = unwrap(await sb.rpc('opname_create', { p_notes: notes }));
      location.hash = '#/opname/' + r.id;
    } catch (e) { toastErr(e); }
  });
}

async function pageOpnameDetail(v, ctx) {
  const id = ctx.params.id;
  const [o, items] = await Promise.all([
    sb.from('stock_opnames').select('*').eq('id', id).single().then(unwrap),
    fetchAll(() => sb.from('stock_opname_items').select('*').eq('opname_id', id).order('updated_at', { ascending: false })),
  ]);
  const draft = o.status === 'draft';
  const counts = new Map(items.map((i) => [i.sku_id, i]));
  const canCount = draft && can('opname_count');
  const canFinal = draft && can('opname_final');
  if (canCount) v.classList.add('has-bar');

  const diffOf = (it) => {
    const s = S.byId.get(it.sku_id);
    const sysG = draft ? (s ? s.qty_good : 0) : it.system_good;
    const sysD = draft ? (s ? s.qty_damaged : 0) : it.system_damaged;
    return {
      sysG, sysD,
      dG: it.counted_good === null ? null : it.counted_good - sysG,
      dD: it.counted_damaged === null ? null : it.counted_damaged - sysD,
    };
  };
  const fmtDiff = (d) => (d === null ? '<span class="muted">–</span>' : d === 0 ? '<span class="muted">0</span>' : `<span class="${d > 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${fmtN(d)}</span>`);

  const draw = () => {
    const arr = [...counts.values()];
    const changed = arr.filter((it) => { const d = diffOf(it); return (d.dG || 0) !== 0 || (d.dD || 0) !== 0; }).length;
    $('#od-body', v).innerHTML = arr.length ? arr.map((it) => {
      const s = S.byId.get(it.sku_id) || { name: '(SKU dihapus)', sku_code: '', unit: '' };
      const d = diffOf(it);
      return `<div class="list-item" data-sku="${it.sku_id}"><div class="grow"><div class="t ellipsis">${esc(s.name)}</div><div class="small muted">${esc(s.sku_code)}</div></div>
        <div style="text-align:right;font-size:13px" class="mono">
          <div>Bagus: <b>${it.counted_good === null ? '–' : fmtN(it.counted_good)}</b> <span class="muted">/ sistem ${fmtN(d.sysG)}</span> ${fmtDiff(d.dG)}</div>
          <div>Rusak: <b>${it.counted_damaged === null ? '–' : fmtN(it.counted_damaged)}</b> <span class="muted">/ sistem ${fmtN(d.sysD)}</span> ${fmtDiff(d.dD)}</div></div></div>`;
    }).join('') : emptyHtml('📋', 'Belum ada barang yang dihitung', canCount ? 'Pindai barcode atau cari barang, lalu isi hasil hitungan fisik.' : '');
    $('#od-sum', v) && ($('#od-sum', v).innerHTML = `<b>${arr.length}</b> barang dihitung · <b>${changed}</b> berselisih`);
  };

  v.innerHTML = `
    <div class="card"><div class="spread"><div><div class="bold mono">${esc(o.opname_no)}</div><div class="small muted">${esc(fmtDate(o.opname_date))} · ${esc(o.created_by_name || '')}</div></div>
      <span class="badge ${OP_STATUS[o.status][1]}">${OP_STATUS[o.status][0]}</span></div>
      ${o.notes ? `<div class="small mt-s">${esc(o.notes)}</div>` : ''}
      ${o.status === 'final' ? `<div class="small muted mt-s">Diselesaikan ${esc(fmtDateTime(o.finalized_at))} oleh ${esc(o.finalized_by_name || '-')}. Selisih sudah dikoreksi ke stok.</div>` : ''}</div>
    ${canCount ? `<div class="row mb"><button class="btn primary grow" id="od-scan">📷 Pindai</button><button class="btn grow" id="od-add">🔎 Cari</button></div>
      <div class="row mb"><button class="btn grow sm" id="od-imp">⬆ Impor hitungan</button><button class="btn grow sm" id="od-tpl">⬇ Daftar hitung</button></div>` : ''}
    <div class="section-title">Hasil hitungan</div>
    <div class="card pad0" id="od-body"></div>
    <div class="row mt"><button class="btn grow sm" id="od-export">⬇ Unduh hasil</button></div>
    ${draft && can('opname_final') ? '<button class="btn danger ghost block mt" id="od-cancel">Batalkan opname ini</button>' : ''}
    ${canCount ? `<div class="sticky-bar"><div class="sum" id="od-sum"></div>${canFinal ? '<button class="btn primary" id="od-final">Selesaikan</button>' : '<span class="small muted">Supervisor/Admin yang menyelesaikan</span>'}</div>` : ''}`;
  draw();

  /* isi hitungan satu barang */
  const askCount = (sku, prefill) => {
    const cur = counts.get(sku.sku_id);
    const sysG = sku.qty_good, sysD = sku.qty_damaged;
    const unitUpc = sku.units_per_carton || 1;
    openSheet(`<h2>${esc(sku.name)}</h2><p class="small muted">${esc(sku.sku_code)} · stok sistem sekarang: bagus <b>${fmtN(sysG)}</b>, rusak <b>${fmtN(sysD)}</b></p>
      <div class="grid2">
        <div class="field"><label>Hitungan BAGUS (${esc(sku.unit)})</label><input class="input" id="oc-g" type="number" inputmode="numeric" min="0" placeholder="kosong = tidak dihitung" value="${cur && cur.counted_good !== null ? cur.counted_good : (prefill ?? '')}"></div>
        <div class="field"><label>Hitungan RUSAK (${esc(sku.unit)})</label><input class="input" id="oc-d" type="number" inputmode="numeric" min="0" placeholder="kosong = tidak dihitung" value="${cur && cur.counted_damaged !== null ? cur.counted_damaged : ''}"></div></div>
      ${unitUpc > 1 ? `<div class="card flat small"><b>Kalkulator dus:</b> <input class="input" id="oc-dus" type="number" inputmode="numeric" min="0" placeholder="jumlah dus" style="width:110px;display:inline-block;min-height:38px"> × ${unitUpc} + <input class="input" id="oc-pcs" type="number" inputmode="numeric" min="0" placeholder="sisa pcs" style="width:110px;display:inline-block;min-height:38px"> <button class="btn sm" id="oc-calc" type="button">Isi bagus</button></div>` : ''}
      <div class="hint">Isi 0 bila barang memang kosong. Biarkan kolom kosong jika tidak ingin menyesuaikan stok bagian itu.</div>
      <div class="err-text" id="oc-err" hidden></div>
      <div class="btn-row mt">${cur ? '<button class="btn danger ghost" id="oc-del">Hapus</button>' : '<button class="btn" data-close>Batal</button>'}<button class="btn primary" id="oc-save">Simpan hitungan</button></div>`, (el, api) => {
      const g = $('#oc-g', el); setTimeout(() => { g.focus(); g.select(); }, 150);
      const calc = $('#oc-calc', el);
      if (calc) calc.addEventListener('click', () => { g.value = intOr($('#oc-dus', el).value, 0) * unitUpc + intOr($('#oc-pcs', el).value, 0); });
      const save = async (good, dmg, btn) => {
        try {
          const r = unwrap(await sb.rpc('opname_set_counts', { p_opname_id: id, p_rows: [{ sku_id: sku.sku_id, good, damaged: dmg }] }));
          if (good === null && dmg === null) counts.delete(sku.sku_id);
          else counts.set(sku.sku_id, { opname_id: id, sku_id: sku.sku_id, counted_good: good, counted_damaged: dmg, system_good: null, system_damaged: null });
          api.close(); draw(); toast('Hitungan disimpan.', 'ok', 1600);
        } catch (e) { toastErr(e); }
      };
      $('#oc-save', el).addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
        const gv = $('#oc-g', el).value.trim(), dv = $('#oc-d', el).value.trim();
        const err = $('#oc-err', el);
        if ((gv !== '' && !/^\d+$/.test(gv)) || (dv !== '' && !/^\d+$/.test(dv))) { err.hidden = false; err.textContent = 'Isi dengan angka bulat 0 atau lebih.'; return; }
        if (gv === '' && dv === '') { err.hidden = false; err.textContent = 'Isi minimal salah satu hitungan (bagus atau rusak).'; return; }
        await save(gv === '' ? null : Number(gv), dv === '' ? null : Number(dv));
      }));
      const del = $('#oc-del', el); if (del) del.addEventListener('click', (ev) => withBusy(ev.currentTarget, () => save(null, null)));
    });
  };
  v.addEventListener('click', (e) => { const it = e.target.closest('#od-body [data-sku]'); if (it && canCount) askCount(S.byId.get(it.dataset.sku)); });

  if (canCount) {
    $('#od-add', v).addEventListener('click', () => openSkuPicker({ title: 'Pilih barang yang dihitung', onlyActive: false, onPick: (s) => askCount(s) }));
    $('#od-scan', v).addEventListener('click', () => openScanner({ title: 'Pindai barang untuk dihitung', single: true, onScan: (code) => {
      const hit = findByCode(code);
      if (!hit) return { ok: false, msg: 'Barcode tidak terdaftar di Master SKU.' };
      askCount(hit.sku, hit.via === 'dus' ? hit.factor : null); return { ok: true, msg: hit.sku.name };
    } }));
    $('#od-tpl', v).addEventListener('click', () => exportXlsx(`Daftar_Hitung_${o.opname_no}`, [{ name: 'Hitung', rows: [['Kode SKU', 'Nama Barang', 'Satuan', 'Stok Sistem Bagus', 'Stok Sistem Rusak', 'Hitung Bagus', 'Hitung Rusak'],
      ...S.skus.filter((s) => s.is_active).map((s) => [s.sku_code, s.name, s.unit, s.qty_good, s.qty_damaged, '', ''])] }]));
    $('#od-imp', v).addEventListener('click', () => {
      openSheet(`<h2>Impor hasil hitungan</h2><p class="small muted">Gunakan file dari tombol "Daftar hitung" (kolom <b>Kode SKU</b>, <b>Hitung Bagus</b>, <b>Hitung Rusak</b>). Baris dengan kolom hitung kosong dilewati.</p>
        <label class="btn primary block">Pilih file (.xlsx / .csv)<input type="file" id="oi-file" accept=".xlsx,.xls,.csv,text/csv" hidden></label><div id="oi-res" class="mt"></div>
        <button class="btn block ghost mt-s" data-close>Tutup</button>`, (el, api) => {
        $('#oi-file', el).addEventListener('change', async (ev) => {
          const f = ev.target.files && ev.target.files[0]; if (!f) return;
          const box = $('#oi-res', el);
          try {
            const aoa = await readSheetRows(f);
            const head = (aoa[0] || []).map((h) => String(h).trim().toLowerCase());
            const ci = head.findIndex((h) => ['kode sku', 'sku', 'sku_code', 'kode'].includes(h));
            const gi = head.findIndex((h) => ['hitung bagus', 'bagus', 'counted_good', 'fisik bagus'].includes(h));
            const di = head.findIndex((h) => ['hitung rusak', 'rusak', 'counted_damaged', 'fisik rusak'].includes(h));
            if (ci < 0 || (gi < 0 && di < 0)) throw new Error('Kolom "Kode SKU" dan "Hitung Bagus"/"Hitung Rusak" tidak ditemukan.');
            const rows = [];
            for (const r of aoa.slice(1)) {
              const code = cellText(r[ci]); if (!code) continue;
              const gv = gi >= 0 ? cellText(r[gi]) : '', dv = di >= 0 ? cellText(r[di]) : '';
              if (gv === '' && dv === '') continue;
              if ((gv !== '' && !/^\d+$/.test(gv)) || (dv !== '' && !/^\d+$/.test(dv))) throw new Error(`Angka tidak valid untuk kode ${code}.`);
              rows.push({ sku_code: code, good: gv === '' ? null : Number(gv), damaged: dv === '' ? null : Number(dv) });
            }
            if (!rows.length) { box.innerHTML = '<div class="err-text">Tidak ada baris dengan hitungan terisi.</div>'; return; }
            let up = 0, missing = [];
            for (let i = 0; i < rows.length; i += 300) {
              const r = unwrap(await sb.rpc('opname_set_counts', { p_opname_id: id, p_rows: rows.slice(i, i + 300) }));
              up += r.updated; missing = missing.concat(r.missing || []);
            }
            box.innerHTML = `<div class="card flat"><b>${fmtN(up)}</b> hitungan tersimpan.${missing.length ? `<div class="small neg mt-s">Kode tidak dikenal (${missing.length}): ${esc(missing.slice(0, 10).join(', '))}${missing.length > 10 ? '…' : ''}</div>` : ''}</div>
              <button class="btn primary block mt-s" id="oi-done">Selesai</button>`;
            $('#oi-done', el).addEventListener('click', () => { api.close(); route(true); });
          } catch (e) { box.innerHTML = `<div class="err-text">${esc(errMsg(e))}</div>`; }
        });
      });
    });
  }

  $('#od-export', v).addEventListener('click', () => exportMenu('Unduh hasil opname', `Opname_${o.opname_no}`, async () => [{ name: 'Opname', rows: [
    ['Kode SKU', 'Nama Barang', 'Satuan', 'Sistem Bagus', 'Hitung Bagus', 'Selisih Bagus', 'Sistem Rusak', 'Hitung Rusak', 'Selisih Rusak'],
    ...[...counts.values()].map((it) => { const s = S.byId.get(it.sku_id) || {}; const d = diffOf(it);
      return [s.sku_code || '', s.name || '', s.unit || '', d.sysG, it.counted_good ?? '', d.dG ?? '', d.sysD, it.counted_damaged ?? '', d.dD ?? '']; })] }]));

  const fb = $('#od-final', v);
  if (fb) fb.addEventListener('click', async () => {
    const arr = [...counts.values()];
    if (!arr.length) { toast('Belum ada barang yang dihitung.', 'err'); return; }
    const lines = arr.map((it) => ({ it, d: diffOf(it) })).filter(({ d }) => (d.dG || 0) !== 0 || (d.dD || 0) !== 0);
    const ok = await confirmBox({
      title: 'Selesaikan opname?', ok: 'Ya, Sesuaikan Stok', danger: true,
      html: `<p class="small">${arr.length} barang dihitung, <b>${lines.length}</b> berselisih. Stok sistem akan diubah mengikuti hitungan fisik <b>dan tidak bisa dibatalkan</b>.</p>
        <div class="card flat small" style="max-height:30vh;overflow:auto;white-space:pre-line">${esc(lines.slice(0, 30).map(({ it, d }) => { const s = S.byId.get(it.sku_id) || {}; return `• ${s.name}: ${d.dG ? 'bagus ' + (d.dG > 0 ? '+' : '') + d.dG : ''}${d.dG && d.dD ? ', ' : ''}${d.dD ? 'rusak ' + (d.dD > 0 ? '+' : '') + d.dD : ''}`; }).join('\n') || 'Tidak ada selisih.')}${lines.length > 30 ? '\n…' : ''}</div>`,
    });
    if (!ok) return;
    await withBusy(fb, async () => {
      try {
        const r = unwrap(await sb.rpc('opname_finalize', { p_opname_id: id }));
        await loadSkus(true);
        toast(`Opname selesai. ${r.adjusted_lines} penyesuaian (${r.trx_no}).`, 'ok', 4500); route(true);
      } catch (e) { toastErr(e); }
    });
  });
  const cb = $('#od-cancel', v);
  if (cb) cb.addEventListener('click', async () => {
    if (!(await confirmBox({ title: 'Batalkan opname?', text: 'Hasil hitungan opname ini dibuang. Stok tidak berubah.', ok: 'Batalkan Opname', danger: true }))) return;
    try { unwrap(await sb.rpc('opname_cancel', { p_opname_id: id })); toast('Opname dibatalkan.'); route(true); } catch (e) { toastErr(e); }
  });
}

/* ------------------------------ KARTU STOK ------------------------------ */
async function pageKartu(v, ctx) {
  if (!S.kartu) S.kartu = { sku: null, from: addDays(todayStr(), -29), to: todayStr(), bucket: 'good' };
  const k = S.kartu;
  if (ctx.qs.sku && S.byId.has(ctx.qs.sku)) { k.sku = ctx.qs.sku; history.replaceState(null, '', '#/kartu'); }
  const pick = () => openSkuPicker({ title: 'Pilih barang', onlyActive: false, onPick: (s) => { k.sku = s.sku_id; route(); } });

  if (!k.sku || !S.byId.has(k.sku)) {
    v.innerHTML = `<div class="card center"><div style="font-size:38px">🗂️</div><p class="muted">Pilih barang untuk melihat kartu stoknya (riwayat pergerakan & saldo).</p>
      <div class="row"><button class="btn primary grow" id="kt-scan">📷 Pindai</button><button class="btn grow" id="kt-pick">🔎 Cari</button></div></div>`;
    $('#kt-pick', v).addEventListener('click', pick);
    $('#kt-scan', v).addEventListener('click', () => openScanner({ title: 'Pindai barang', single: true, onScan: (code) => {
      const hit = findByCode(code); if (!hit) return { ok: false, msg: 'Barcode tidak terdaftar di Master SKU.' };
      k.sku = hit.sku.sku_id; route(); return { ok: true, msg: hit.sku.name };
    } }));
    return;
  }
  const s = S.byId.get(k.sku);
  v.innerHTML = `
    <div class="card"><div class="spread"><div class="grow"><div class="bold">${esc(s.name)}</div><div class="small muted">${esc(s.sku_code)} · ${esc(s.unit)}${s.units_per_carton > 1 ? ' · ' + s.units_per_carton + '/dus' : ''}</div></div>
      <button class="btn sm" id="kt-change">Ganti</button></div>
      <div class="grid2 mt-s"><div class="stat" style="box-shadow:none;background:var(--surface2)"><div class="lbl">Stok bagus</div><div class="val">${fmtN(s.qty_good)}</div></div>
      <div class="stat dmg" style="box-shadow:none;background:var(--surface2)"><div class="lbl">Stok rusak</div><div class="val">${fmtN(s.qty_damaged)}</div></div></div></div>
    <div class="tabs"><button data-b="good" class="${k.bucket === 'good' ? 'on' : ''}">Stok Bagus</button><button data-b="damaged" class="${k.bucket === 'damaged' ? 'on' : ''}">Stok Rusak</button></div>
    <div class="card"><div class="grid2"><div class="field" style="margin:0"><label>Dari</label><input class="input" type="date" id="kt-from" value="${k.from}"></div>
      <div class="field" style="margin:0"><label>Sampai</label><input class="input" type="date" id="kt-to" value="${k.to}"></div></div>
      <div class="row wrap mt-s" style="gap:6px"><button class="chip" data-p="6">7 hari</button><button class="chip" data-p="29">30 hari</button><button class="chip" data-p="89">90 hari</button><button class="chip" data-p="m">Bulan ini</button></div></div>
    <div class="spread mb"><div class="small muted" id="kt-count"></div><button class="btn sm" id="kt-export">⬇ Unduh</button></div>
    <div id="kt-body">${loadingHtml()}</div>`;
  $('#kt-change', v).addEventListener('click', pick);
  $$('.tabs [data-b]', v).forEach((b) => b.addEventListener('click', () => { k.bucket = b.dataset.b; route(); }));
  const setR = (a, b) => { k.from = a; k.to = b; route(); };
  $('#kt-from', v).addEventListener('change', (e) => { if (e.target.value) { k.from = e.target.value; if (k.to < k.from) k.to = k.from; route(); } });
  $('#kt-to', v).addEventListener('change', (e) => { if (e.target.value) { k.to = e.target.value; if (k.from > k.to) k.from = k.to; route(); } });
  $$('[data-p]', v).forEach((b) => b.addEventListener('click', () => { const t = todayStr(); b.dataset.p === 'm' ? setR(t.slice(0, 8) + '01', t) : setR(addDays(t, -Number(b.dataset.p)), t); }));

  const [openBal, mv] = await Promise.all([
    sb.rpc('sku_balance_before', { p_sku_id: k.sku, p_date: k.from }).then(unwrap),
    fetchAll(() => sb.from('stock_movements')
      .select('id,trx_date,trx_type,bucket,qty_change,balance_after,created_at,transactions(trx_no,reference_no,party,created_by_name)')
      .eq('sku_id', k.sku).eq('bucket', k.bucket).gte('trx_date', k.from).lte('trx_date', k.to).order('id')),
  ]);
  if (ctx.token !== routeToken) return;
  const ob = Number((Array.isArray(openBal) ? openBal[0] : openBal)[k.bucket === 'good' ? 'good' : 'damaged']) || 0;
  const tin = mv.filter((m) => m.qty_change > 0).reduce((a, m) => a + m.qty_change, 0);
  const tout = mv.filter((m) => m.qty_change < 0).reduce((a, m) => a - m.qty_change, 0);
  const endBal = mv.length ? mv[mv.length - 1].balance_after : ob;
  $('#kt-count', v).textContent = `${fmtN(mv.length)} pergerakan`;
  $('#kt-body', v).innerHTML = `<div class="table-wrap"><table class="tbl">
    <tr><th>Tanggal</th><th class="l">Keterangan</th><th>Masuk</th><th>Keluar</th><th>Saldo</th></tr>
    <tr class="total"><td>Saldo awal</td><td class="l"></td><td></td><td></td><td>${fmtN(ob)}</td></tr>
    ${mv.map((m) => `<tr><td>${fmtDate(m.trx_date)}</td><td class="l" style="max-width:190px;overflow:hidden;text-overflow:ellipsis">${trxBadge(m.trx_type)} ${esc(m.transactions?.trx_no || '')}
      <div class="tiny muted">${esc([m.transactions?.party, m.transactions?.reference_no].filter(Boolean).join(' · '))}</div></td>
      <td class="pos">${m.qty_change > 0 ? fmtN(m.qty_change) : ''}</td><td class="neg">${m.qty_change < 0 ? fmtN(-m.qty_change) : ''}</td><td><b>${fmtN(m.balance_after)}</b></td></tr>`).join('')}
    <tr class="total"><td>Total / akhir</td><td class="l"></td><td class="pos">${fmtN(tin)}</td><td class="neg">${fmtN(tout)}</td><td>${fmtN(endBal)}</td></tr></table></div>
    ${mv.length ? '' : emptyHtml('🗂️', 'Tidak ada pergerakan pada periode ini')}`;
  $('#kt-export', v).addEventListener('click', () => exportMenu('Unduh kartu stok', `KartuStok_${s.sku_code}_${k.bucket}_${k.from}_sd_${k.to}`, async () => [{ name: 'Kartu Stok', rows: [
    [`Kartu Stok ${BUCKET[k.bucket]}`, s.sku_code, s.name], [`Periode ${fmtDate(k.from)} s/d ${fmtDate(k.to)}`], [],
    ['Tanggal', 'Jam (WIB)', 'No. Transaksi', 'Jenis', 'Referensi', 'Pihak', 'Dicatat Oleh', 'Masuk', 'Keluar', 'Saldo'],
    ['', '', '', 'Saldo awal', '', '', '', '', '', ob],
    ...mv.map((m) => [fmtDate(m.trx_date), new Date(m.created_at).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }), m.transactions?.trx_no || '',
      (TRX[m.trx_type] || {}).label || m.trx_type, m.transactions?.reference_no || '', m.transactions?.party || '', m.transactions?.created_by_name || '',
      m.qty_change > 0 ? m.qty_change : '', m.qty_change < 0 ? -m.qty_change : '', m.balance_after]),
    ['', '', '', 'Total / akhir', '', '', '', tin, tout, endBal]] }]));
}

/* -------------------------------- LAPORAN -------------------------------- */
async function pageLaporan(v, ctx) {
  if (!S.rep) S.rep = { mode: 'daily', day: todayStr(), month: todayStr().slice(0, 7), bucket: 'good', all: false };
  const r = S.rep;
  const [from, to] = r.mode === 'daily' ? [r.day, r.day] : monthRange(r.month);
  const title = r.mode === 'daily' ? `Laporan Harian ${fmtDate(r.day)}` : `Laporan Bulanan ${fmtMonth(r.month)}`;
  v.innerHTML = `
    <div class="tabs"><button data-m="daily" class="${r.mode === 'daily' ? 'on' : ''}">Harian</button><button data-m="monthly" class="${r.mode === 'monthly' ? 'on' : ''}">Bulanan</button></div>
    <div class="card">${r.mode === 'daily'
      ? `<div class="field" style="margin:0"><label>Tanggal</label><input class="input" type="date" id="lp-day" value="${r.day}" max="${todayStr()}"></div>
         <div class="row mt-s" style="gap:6px"><button class="chip" id="lp-yday">Kemarin</button><button class="chip" id="lp-today">Hari ini</button></div>`
      : `<div class="field" style="margin:0"><label>Bulan</label><input class="input" type="month" id="lp-month" value="${r.month}" max="${todayStr().slice(0, 7)}"></div>`}</div>
    <div id="lp-body">${loadingHtml()}</div>`;
  $$('.tabs [data-m]', v).forEach((b) => b.addEventListener('click', () => { r.mode = b.dataset.m; route(); }));
  const ld = $('#lp-day', v); if (ld) ld.addEventListener('change', (e) => { if (e.target.value) { r.day = e.target.value; route(); } });
  const lm = $('#lp-month', v); if (lm) lm.addEventListener('change', (e) => { if (e.target.value) { r.month = e.target.value; route(); } });
  const yd = $('#lp-yday', v); if (yd) { yd.addEventListener('click', () => { r.day = addDays(todayStr(), -1); route(); }); $('#lp-today', v).addEventListener('click', () => { r.day = todayStr(); route(); }); }

  const [rows, daily] = await Promise.all([
    sb.rpc('report_stock_period', { p_from: from, p_to: to }).then(unwrap),
    sb.rpc('report_daily', { p_from: from, p_to: to }).then(unwrap),
  ]);
  if (ctx.token !== routeToken) return;
  const num = (x) => Number(x) || 0;
  const sum = (key) => rows.reduce((a, x) => a + num(x[key]), 0);
  const act = (x) => ['in_qty', 'out_qty', 'ret_good', 'adj_good', 'ret_damaged', 'dispose_qty', 'adj_damaged'].some((k) => num(x[k]) !== 0);
  const hasStock = (x) => num(x.open_good) || num(x.close_good) || num(x.open_damaged) || num(x.close_damaged);
  const shown = rows.filter((x) => (r.all ? true : act(x) || (r.mode === 'daily' ? false : false)));
  const bg = r.bucket === 'good';
  const sumDay = (key) => daily.reduce((a, d) => a + num(d[key]), 0);

  $('#lp-body', v).innerHTML = `
    <div class="grid2">
      <div class="stat in"><div class="lbl">Barang masuk</div><div class="val">${fmtN(sum('in_qty'))}</div></div>
      <div class="stat out"><div class="lbl">Barang keluar</div><div class="val">${fmtN(sum('out_qty'))}</div></div>
      <div class="stat warn"><div class="lbl">Retur bagus</div><div class="val">${fmtN(sum('ret_good'))}</div></div>
      <div class="stat dmg"><div class="lbl">Retur rusak</div><div class="val">${fmtN(sum('ret_damaged'))}</div></div></div>
    <div class="card mt"><div class="kv"><span>Stok bagus awal → akhir</span><span>${fmtN(sum('open_good'))} → <b>${fmtN(sum('close_good'))}</b></span></div>
      <div class="kv"><span>Stok rusak awal → akhir</span><span>${fmtN(sum('open_damaged'))} → <b>${fmtN(sum('close_damaged'))}</b></span></div>
      <div class="kv"><span>Jumlah transaksi</span><span>${fmtN(sumDay('trx_count'))}</span></div>
      <div class="kv"><span>Koreksi (opname/pembatalan)</span><span>bagus ${sum('adj_good') > 0 ? '+' : ''}${fmtN(sum('adj_good'))} · rusak ${sum('adj_damaged') > 0 ? '+' : ''}${fmtN(sum('adj_damaged'))}</span></div>
      <div class="kv"><span>Stok rusak dikeluarkan</span><span>${fmtN(sum('dispose_qty'))}</span></div></div>
    ${r.mode === 'monthly' ? `<div class="section-title">Rekap per hari</div><div class="table-wrap"><table class="tbl">
      <tr><th>Tgl</th><th>Masuk</th><th>Keluar</th><th>Retur B</th><th>Retur R</th><th>Trx</th></tr>
      ${daily.map((d) => `<tr><td>${String(d.day).slice(8, 10)}/${String(d.day).slice(5, 7)}</td><td class="pos">${num(d.in_qty) ? fmtN(d.in_qty) : ''}</td><td class="neg">${num(d.out_qty) ? fmtN(d.out_qty) : ''}</td><td>${num(d.ret_good) ? fmtN(d.ret_good) : ''}</td><td>${num(d.ret_damaged) ? fmtN(d.ret_damaged) : ''}</td><td>${num(d.trx_count) ? fmtN(d.trx_count) : ''}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td>${fmtN(sumDay('in_qty'))}</td><td>${fmtN(sumDay('out_qty'))}</td><td>${fmtN(sumDay('ret_good'))}</td><td>${fmtN(sumDay('ret_damaged'))}</td><td>${fmtN(sumDay('trx_count'))}</td></tr></table></div>` : ''}
    <div class="section-title">Rincian per SKU</div>
    <div class="tabs"><button data-b="good" class="${bg ? 'on' : ''}">Stok Bagus</button><button data-b="damaged" class="${!bg ? 'on' : ''}">Stok Rusak</button></div>
    <label class="check"><input type="checkbox" id="lp-all" ${r.all ? 'checked' : ''}> Tampilkan semua SKU (termasuk tanpa pergerakan)</label>
    <div class="spread mb"><div class="small muted">${fmtN(shown.length)} SKU ${r.all ? '' : 'dengan pergerakan'}</div><button class="btn sm primary" id="lp-export">⬇ Unduh laporan</button></div>
    ${shown.length ? `<div class="table-wrap"><table class="tbl">
      ${bg ? '<tr><th>SKU</th><th>Awal</th><th>Masuk</th><th>Keluar</th><th>Retur</th><th>Koreksi</th><th>Akhir</th></tr>' : '<tr><th>SKU</th><th>Awal</th><th>Retur Rusak</th><th>Keluar</th><th>Koreksi</th><th>Akhir</th></tr>'}
      ${shown.map((x) => `<tr><td title="${esc(x.name)}">${esc(x.name)}<div class="tiny muted">${esc(x.sku_code)}</div></td>${bg
        ? `<td>${fmtN(x.open_good)}</td><td class="pos">${num(x.in_qty) ? fmtN(x.in_qty) : ''}</td><td class="neg">${num(x.out_qty) ? fmtN(x.out_qty) : ''}</td><td>${num(x.ret_good) ? fmtN(x.ret_good) : ''}</td><td>${num(x.adj_good) ? (x.adj_good > 0 ? '+' : '') + fmtN(x.adj_good) : ''}</td><td><b>${fmtN(x.close_good)}</b></td>`
        : `<td>${fmtN(x.open_damaged)}</td><td>${num(x.ret_damaged) ? fmtN(x.ret_damaged) : ''}</td><td class="neg">${num(x.dispose_qty) ? fmtN(x.dispose_qty) : ''}</td><td>${num(x.adj_damaged) ? (x.adj_damaged > 0 ? '+' : '') + fmtN(x.adj_damaged) : ''}</td><td><b>${fmtN(x.close_damaged)}</b></td>`}</tr>`).join('')}
      <tr class="total"><td>Total</td>${bg ? `<td>${fmtN(sum('open_good'))}</td><td>${fmtN(sum('in_qty'))}</td><td>${fmtN(sum('out_qty'))}</td><td>${fmtN(sum('ret_good'))}</td><td>${fmtN(sum('adj_good'))}</td><td>${fmtN(sum('close_good'))}</td>`
        : `<td>${fmtN(sum('open_damaged'))}</td><td>${fmtN(sum('ret_damaged'))}</td><td>${fmtN(sum('dispose_qty'))}</td><td>${fmtN(sum('adj_damaged'))}</td><td>${fmtN(sum('close_damaged'))}</td>`}</tr></table></div>`
      : emptyHtml('📊', 'Tidak ada pergerakan stok pada periode ini', 'Centang "Tampilkan semua SKU" untuk melihat saldo seluruh barang.')}
    <p class="tiny muted">Rumus stok bagus: Awal + Masuk − Keluar + Retur Bagus + Koreksi = Akhir. Stok rusak: Awal + Retur Rusak − Dikeluarkan + Koreksi = Akhir. Jumlah dalam pcs.</p>`;

  $$('.tabs [data-b]', v).forEach((b) => b.addEventListener('click', () => { r.bucket = b.dataset.b; route(); }));
  $('#lp-all', v).addEventListener('change', (e) => { r.all = e.target.checked; route(); });
  $('#lp-export', v).addEventListener('click', () => exportMenu('Unduh laporan', `${r.mode === 'daily' ? 'Laporan_Harian_' + r.day : 'Laporan_Bulanan_' + r.month}`, async () => {
    const all = rows.filter((x) => r.all || act(x) || hasStock(x));
    const sheetsDef = [
      { name: 'Ringkasan', rows: [[title], [], ['Barang masuk', sum('in_qty')], ['Barang keluar', sum('out_qty')], ['Retur bagus', sum('ret_good')], ['Retur rusak', sum('ret_damaged')],
        ['Stok rusak dikeluarkan', sum('dispose_qty')], ['Koreksi bagus (opname/pembatalan)', sum('adj_good')], ['Koreksi rusak (opname/pembatalan)', sum('adj_damaged')],
        ['Stok bagus awal', sum('open_good')], ['Stok bagus akhir', sum('close_good')], ['Stok rusak awal', sum('open_damaged')], ['Stok rusak akhir', sum('close_damaged')], ['Jumlah transaksi', sumDay('trx_count')]] },
      { name: 'Stok Bagus', rows: [['Kode SKU', 'Nama Barang', 'Kategori', 'Satuan', 'Awal', 'Masuk', 'Keluar', 'Retur Bagus', 'Koreksi', 'Akhir'],
        ...all.map((x) => [x.sku_code, x.name, x.category || '', x.unit, num(x.open_good), num(x.in_qty), num(x.out_qty), num(x.ret_good), num(x.adj_good), num(x.close_good)]),
        ['TOTAL', '', '', '', sum('open_good'), sum('in_qty'), sum('out_qty'), sum('ret_good'), sum('adj_good'), sum('close_good')]] },
      { name: 'Stok Rusak', rows: [['Kode SKU', 'Nama Barang', 'Kategori', 'Satuan', 'Awal', 'Retur Rusak', 'Dikeluarkan', 'Koreksi', 'Akhir'],
        ...all.map((x) => [x.sku_code, x.name, x.category || '', x.unit, num(x.open_damaged), num(x.ret_damaged), num(x.dispose_qty), num(x.adj_damaged), num(x.close_damaged)]),
        ['TOTAL', '', '', '', sum('open_damaged'), sum('ret_damaged'), sum('dispose_qty'), sum('adj_damaged'), sum('close_damaged')]] },
    ];
    if (r.mode === 'monthly') sheetsDef.splice(1, 0, { name: 'Per Hari', rows: [['Tanggal', 'Masuk', 'Keluar', 'Retur Bagus', 'Retur Rusak', 'Rusak Dikeluarkan', 'Koreksi', 'Jumlah Transaksi'],
      ...daily.map((d) => [fmtDate(d.day), num(d.in_qty), num(d.out_qty), num(d.ret_good), num(d.ret_damaged), num(d.dispose_qty), num(d.adj_net), num(d.trx_count)]),
      ['TOTAL', sumDay('in_qty'), sumDay('out_qty'), sumDay('ret_good'), sumDay('ret_damaged'), sumDay('dispose_qty'), sumDay('adj_net'), sumDay('trx_count')]] });
    return sheetsDef;
  }));
}

/* ===================================================================
   Bagian 7: start-up aplikasi
   =================================================================== */
window.addEventListener('error', (e) => {
  if (/play\(\) request|AbortError/i.test(String(e.message))) { e.preventDefault(); return; }
  try { console.error(e.error || e.message); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  const m = String((e.reason && e.reason.message) || e.reason || '');
  if (/AbortError|The user aborted|play\(\) request/i.test(m)) { e.preventDefault(); return; }
  try { console.error(e.reason); toast(errMsg(e.reason), 'err', 5200); } catch (_) {}
});

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (typeof supabase === 'undefined') {
    $('#boot').innerHTML = '<div class="card" style="margin:20px"><b>Pustaka aplikasi gagal dimuat.</b><p class="small">Periksa koneksi internet lalu muat ulang halaman.</p><button class="btn primary" onclick="location.reload()">Muat ulang</button></div>';
    return;
  }
  if (!initSupabase()) { renderSetup(); return; }
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { renderAuth('login'); return; }
    sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && S.profile) doLogout(); });
    await afterLogin();
  } catch (e) {
    $('#boot').hidden = true; appEl().hidden = false;
    appEl().innerHTML = `<div class="auth-wrap"><div class="card"><h2>Tidak dapat terhubung</h2><p class="small">${esc(errMsg(e))}</p>
      <button class="btn primary block" onclick="location.reload()">Coba lagi</button>
      <button class="btn block mt-s" id="bt-reset">Atur ulang koneksi</button></div></div>`;
    $('#bt-reset').addEventListener('click', () => { localStorage.removeItem('btc_sb_url'); localStorage.removeItem('btc_sb_key'); location.reload(); });
  }
}
boot();

