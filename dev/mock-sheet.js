// Test helper: runs the real apps-script/*.gs files against a simulated Google Sheet.
// Formulas are calculated with the HyperFormula engine (dev dependency), so the Summary/Missed tabs can be tested.
// Not used by the live site.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { HyperFormula } = require('hyperformula');

const pad = (n) => String(n).padStart(2, '0');
const EPOCH = Date.UTC(1899, 11, 30);

function fmtSerial(n, fmt) {
  const ms = Math.round(n * 86400000);
  const d = new Date(EPOCH + ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (fmt === 'yyyy-mm-dd') return date;
  if (fmt === 'hh:mm') return time;
  if (fmt === 'yyyy-mm-dd hh:mm:ss') return `${date} ${time}:${pad(d.getUTCSeconds())}`;
  return null;
}

class Workbook {
  constructor(clock) { this.sheets = []; this.clock = clock; this.cache = null; }
  invalidate() { this.cache = null; }
  hf() {
    if (this.cache) return this.cache;
    const data = {};
    this.sheets.forEach((sh) => {
      data[sh.name] = sh.rows.map((row) => row.map((c) => {
        if (c.f) return c.f;
        if (c.v === '' || c.v === null || c.v === undefined) return null;
        if (typeof c.v === 'string' && c.v.startsWith('=')) return ' ' + c.v;
        return c.v;
      }));
    });
    const RealDate = global.Date;
    const fixed = this.clock.now;
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
      static now() { return fixed; }
    }
    global.Date = FakeDate;
    try { this.cache = HyperFormula.buildFromSheets(data, { licenseKey: 'gpl-v3', useColumnIndex: false }); }
    finally { global.Date = RealDate; }
    return this.cache;
  }
}

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  _each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.sh._cell(this.r + i, this.c + j), i, j); }
  _val(cell, r, c) {
    if (!cell.f) return cell.v;
    this.sh.wb.formulaReads = (this.sh.wb.formulaReads || 0) + 1;
    const hf = this.sh.wb.hf();
    const sid = hf.getSheetId(this.sh.name);
    const v = hf.getCellValue({ sheet: sid, row: r - 1, col: c - 1 });
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return '#ERROR ' + (v.value || v.type);
    return v;
  }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { out.push([]); for (let j = 0; j < this.nc; j++) out[i].push(this._val(this.sh._cell(this.r + i, this.c + j), this.r + i, this.c + j)); } return out; }
  getDisplayValues() {
    return this.getValues().map((row, i) => row.map((v, j) => {
      const cell = this.sh._cell(this.r + i, this.c + j);
      if (typeof v === 'number') return fmtSerial(v, cell.fmt) ?? String(v);
      return v === null || v === undefined ? '' : String(v);
    }));
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(a) {
    if (a.length !== this.nr || a[0].length !== this.nc) throw new Error(`setValues size mismatch: range ${this.nr}x${this.nc}, data ${a.length}x${a[0].length}`);
    this._each((cell, i, j) => { this.sh._set(cell, a[i][j]); });
    this.sh.wb.invalidate();
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFormulas(a) {
    if (a.length !== this.nr || a[0].length !== this.nc) throw new Error(`setFormulas size mismatch: range ${this.nr}x${this.nc}, data ${a.length}x${a[0].length}`);
    this._each((cell, i, j) => { cell.f = a[i][j]; cell.v = ''; });
    this.sh.wb.invalidate();
    return this;
  }
  setFormula(f) { return this.setFormulas([[f]]); }
  setNumberFormat(f) { this._each((cell) => { cell.fmt = f; }); return this; }
  setFontWeight() { return this; }
  clearContent() { this._each((cell) => { cell.v = ''; cell.f = null; }); this.sh.wb.invalidate(); return this; }
}

class Sheet {
  constructor(wb, name, maxRows = 1000) { this.wb = wb; this.name = name; this.rows = []; this.maxRows = maxRows; this.maxCols = 26; this.frozen = 0; }
  _cell(r, c) {
    if (r > this.maxRows) throw new Error(`Row ${r} is beyond the sheet (${this.maxRows} rows)`);
    if (c > this.maxCols) throw new Error(`Column ${c} is beyond the sheet (${this.maxCols} columns)`);
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c) row.push({ v: '', f: null, fmt: '' });
    return row[c - 1];
  }
  // What a real sheet does when you type a value into a cell with a given format.
  _set(cell, v) {
    cell.f = null;
    if (typeof v === 'string' && cell.fmt !== '@' && v.startsWith('=')) { cell.f = v; cell.v = ''; return; }
    if (typeof v === 'string' && cell.fmt !== '@' && v.trim() !== '' && isFinite(Number(v))) { cell.v = Number(v); return; }
    cell.v = v;
  }
  getName() { return this.name; }
  setName(n) { this.name = n; this.wb.invalidate(); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getLastRow() { for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i].some((x) => (x.v !== '' && x.v !== null) || x.f)) return i + 1; return 0; }
  getLastColumn() { let m = 0; this.rows.forEach((r) => r.forEach((x, j) => { if ((x.v !== '' && x.v !== null) || x.f) m = Math.max(m, j + 1); })); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  setFrozenRows(n) { this.frozen = n; }
  deleteRow(r) {
    if (this.maxRows - 1 <= this.frozen) throw new Error("You can't delete all the non-frozen rows on a sheet.");
    this.rows.splice(r - 1, 1); this.maxRows--; this.wb.invalidate();
  }
}

// Builds the old single-tab sheet from the CSV, as if imported with "convert" ticked OFF (everything text) or ON.
function fillOldTab(sheet, csvText, mode) {
  parseCsv(csvText).forEach((cols, i) => cols.forEach((val, j) => {
    const cell = sheet._cell(i + 1, j + 1);
    if (i === 0 || mode === 'text' || val === '') { cell.v = val; return; }
    if (j === 0 || j === 5) cell.v = Number(val);
    else if (j === 1) { const [y, m, d] = val.split('-').map(Number); cell.v = Date.UTC(y, m - 1, d) / 86400000 + 25569; cell.fmt = 'yyyy-mm-dd'; }
    else if (j === 2) { const [h, mi] = val.split(':').map(Number); cell.v = (h * 60 + mi) / 1440; cell.fmt = 'hh:mm'; }
    else cell.v = val;
  }));
  sheet.wb.invalidate();
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/**
 * Creates a simulated spreadsheet with the real Apps Script files loaded.
 * opts.csvFile + opts.mode: start with the old single tab ("Sheet1") imported from the CSV.
 * opts.now: fixed clock, e.g. '2026-09-26T09:30:00Z'.
 */
function createBackend({ key = 'test-key-12345', csvFile, mode = 'text', now = '2026-09-26T09:30:00Z', oldTabName = 'Sheet1' } = {}) {
  const clock = { now: Date.parse(now) };
  const wb = new Workbook(clock);
  const ss = {
    getSheetByName: (n) => wb.sheets.find((s) => s.name === n) || null,
    getSheets: () => wb.sheets.slice(),
    insertSheet: (n) => { if (ss.getSheetByName(n)) throw new Error('A sheet with the name "' + n + '" already exists.'); const s = new Sheet(wb, n); wb.sheets.push(s); wb.invalidate(); return s; },
    getSpreadsheetTimeZone: () => 'UTC'
  };
  if (csvFile) fillOldTab(ss.insertSheet(oldTabName), fs.readFileSync(csvFile, 'utf8'), mode);

  const props = { SECRET_KEY: key };
  const logs = [];
  const RealDate = Date;
  class ClockDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  const fmtDate = (d, f) => f
    .replace('yyyy', d.getUTCFullYear()).replace('MM', pad(d.getUTCMonth() + 1)).replace('dd', pad(d.getUTCDate()))
    .replace('HH', pad(d.getUTCHours())).replace('mm', pad(d.getUTCMinutes())).replace('ss', pad(d.getUTCSeconds()));
  const ctx = vm.createContext({
    SpreadsheetApp: { getActive: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }) },
    Utilities: { sleep() {}, getUuid: () => crypto.randomUUID(), formatDate: (d, tz, f) => fmtDate(d, f) },
    Logger: { log: (m) => logs.push(m) },
    Date: ClockDate, JSON, Object, Array, String, Number, Math, isFinite, Error
  });
  const dir = path.join(__dirname, '..', 'apps-script');
  // Apps Script shares one global scope across files, so load them as one program.
  vm.runInContext(['Code.gs', 'Migrate.gs'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'), ctx);
  const run = (name, ...args) => vm.runInContext(name, ctx)(...args);
  const post = (body) => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).content);
  const tab = (name) => ss.getSheetByName(name);
  const grid = (name) => { const s = tab(name); return s.getRange(1, 1, Math.max(s.getLastRow(), 1), Math.max(s.getLastColumn(), 1)).getDisplayValues(); };
  return { wb, ss, props, logs, post, run, tab, grid, clock, key, setNow: (iso) => { clock.now = Date.parse(iso); wb.invalidate(); } };
}

module.exports = { createBackend };
