/**
 * Dad Fit tracker: Google Apps Script web app, bound to the Google Sheet.
 *
 * The secret key is NOT in this file. It lives in Script Properties
 * (Project Settings > Script properties > SECRET_KEY) and is checked on every request.
 *
 * Tabs (the sheet is the master record; edit it directly any time):
 *   Log           one row per kettlebell session
 *   Sets          one row per exercise per session (written from the plan when you tap)
 *   Plan          the current A, B, C prescription (left table) and their day / rounds (right table)
 *   Plan history  every version of the plan, with the date it first applied
 *   Sport         tag rugby and badminton
 *   Breaks        planned breaks (so they are not counted as misses)
 *   Missed        worked out by formula from the schedule
 *   Summary       formulas only
 *   Settings      programme start date
 *
 * Dates and times are stored as real sheet dates (not text), so formulas and sorting work.
 */

const TAB = {
  LOG: 'Log', SETS: 'Sets', PLAN: 'Plan', HISTORY: 'Plan history', SPORT: 'Sport',
  BREAKS: 'Breaks', MISSED: 'Missed', SUMMARY: 'Summary', SETTINGS: 'Settings'
};
const SESSIONS = ['A', 'B', 'C'];
const SPORTS = ['rugby', 'badminton'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const UNITS = ['reps', 'sec'];
const SIDES = ['', 'arm', 'leg', 'side'];

const LOG_HEADERS = ['workout_no', 'session', 'session_no', 'date', 'start_time', 'logged_at', 'day', 'week', 'on_schedule', 'plan_version', 'rounds', 'label', 'notes', 'id'];
const SETS_HEADERS = ['workout_no', 'session', 'exercise', 'amount', 'unit', 'per_side', 'rounds', 'variant', 'note', 'total', 'date', 'week', 'log_id'];
const PLAN_EX_HEADERS = ['session', 'exercise_no', 'exercise', 'amount', 'unit', 'per_side', 'variant'];
const PLAN_SESS_HEADERS = ['session', 'day', 'rounds', 'version']; // sits in columns I:L, rows 2-4
const HISTORY_HEADERS = ['version', 'session', 'effective_from', 'day', 'rounds', 'exercise_no', 'exercise', 'amount', 'unit', 'per_side', 'variant'];
const SPORT_HEADERS = ['date', 'activity', 'duration_min', 'notes', 'logged_at', 'id', 'day'];
const BREAKS_HEADERS = ['start', 'end', 'reason'];

const FMT_DATE = 'yyyy-mm-dd';
const FMT_TIME = 'hh:mm';
const FMT_STAMP = 'yyyy-mm-dd hh:mm:ss';
const MISSED_ROWS = 450;      // days listed on the Missed tab, starting at the programme start
const SUMMARY_EX_FIRST = 19;  // first exercise row on the Summary tab
const SUMMARY_EX_ROWS = 20;
const SUMMARY_WEEKS = 26;
const DAY_FORMULA = 'CHOOSE(WEEKDAY(%,2),"Mon","Tue","Wed","Thu","Fri","Sat","Sun")';

// ---------------------------------------------------------------- web app entry points

function doGet() {
  // No data without the key, and the key is never accepted in a URL.
  return reply_({ ok: true, message: 'Dad Fit tracker web app is running. The page talks to it with POST requests.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: 'bad_request', message: 'Request was not valid JSON.' });
  }
  try {
    if (!keyOk_(req && req.key)) {
      Utilities.sleep(1000); // slow down guessing
      return reply_({ ok: false, error: 'bad_key' });
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      return reply_(handle_(req));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply_({ ok: false, error: err.code || 'server_error', message: String(err.message || err) });
  }
}

function handle_(req) {
  switch (req.action) {
    case 'load': return load_();
    case 'add':  return addSession_(req);
    case 'sport': return addSport_(req);
    case 'undo': return undo_(req);
    case 'note': return addNote_(req);
    default:     return fail_('bad_action', 'Unknown action: ' + req.action);
  }
}

function keyOk_(given) {
  const real = PropertiesService.getScriptProperties().getProperty('SECRET_KEY');
  if (!real || real.length < 8) fail_('not_configured', 'SECRET_KEY is missing or shorter than 8 characters in Script properties.');
  if (typeof given !== 'string' || given.length !== real.length) return false;
  let diff = 0;
  for (let i = 0; i < real.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- load

function load_() {
  const plan = readPlan_();
  const logs = readLog_();
  const sport = readSport_();
  const latest = logs.map(entryFromLog_).concat(sport.map(entryFromSport_));
  latest.sort(function (a, b) { return (b.date + (b.loggedAt || '')).localeCompare(a.date + (a.loggedAt || '')) || b.seq - a.seq; });
  const lastSession = logs.length ? entryFromLog_(logs.reduce(function (m, r) { return r.n > m.n ? r : m; })) : null;
  return {
    ok: true,
    plan: publicPlan_(plan),
    order: scheduleOrder_(plan),
    due: dueSession_(plan, lastSession),
    total: logs.length,
    last: lastSession,
    latest: latest.slice(0, 10),
    undoId: undoTarget_(logs, sport) ? undoTarget_(logs, sport).id : ''
  };
}

/** Sessions in the order they fall in the week (Mon first), e.g. C, A, B. */
function scheduleOrder_(plan) {
  return SESSIONS.slice().sort(function (a, b) { return DAY_NAMES.indexOf(plan.sessions[a].day) - DAY_NAMES.indexOf(plan.sessions[b].day); });
}

/** The session after the last one logged, in rotation. With nothing logged yet: the first in the week. */
function dueSession_(plan, last) {
  const order = scheduleOrder_(plan);
  if (!last) return order[0];
  const i = order.indexOf(last.session);
  return order[(i + 1) % order.length];
}

// ---------------------------------------------------------------- add a session

function addSession_(req) {
  const session = String(req.session || '').toUpperCase();
  if (SESSIONS.indexOf(session) < 0) fail_('bad_request', 'Unknown session: ' + req.session);
  const id = cleanId_(req.id) || newId_();
  const log = sheet_(TAB.LOG);
  const existing = readLog_();
  const dup = existing.filter(function (r) { return r.id === id; })[0];
  if (dup) return { ok: true, duplicate: true, entry: entryFromLog_(dup) }; // a retry of an add that already worked

  const now = nowParts_();
  const date = req.date ? checkDate_(req.date) : now.date;
  const time = req.time === '' ? '' : (req.time ? checkTime_(req.time) : now.time); // time '' = unknown, leave blank
  const plan = readPlan_();
  const ps = plan.sessions[session];
  const version = ensureVersion_(session, ps, date);
  const n = existing.reduce(function (m, r) { return Math.max(m, r.n); }, 0) + 1;
  const row = log.getLastRow() + 1;
  const notes = cut_(req.note, 2000);

  setFormats_(log, row, 1, [[4, FMT_DATE], [5, FMT_TIME], [6, FMT_STAMP], [10, '@'], [12, '@'], [13, '@'], [14, '@']]);
  log.getRange(row, 1, 1, 2).setValues([[n, session]]);
  log.getRange(row, 3).setFormula(logFormulaSessionNo_(row));
  log.getRange(row, 4, 1, 3).setValues([[dateSerial_(date), time === '' ? '' : timeSerial_(time), stampSerial_(now.date, now.time + ':' + now.sec)]]);
  log.getRange(row, 7, 1, 3).setFormulas([logFormulasDerived_(row)]);
  log.getRange(row, 10, 1, 5).setValues([[version, ps.rounds, '', notes, id]]);

  const sets = sheet_(TAB.SETS);
  const first = sets.getLastRow() + 1;
  ps.exercises.forEach(function (ex, i) {
    const r = first + i;
    setFormats_(sets, r, 1, [[2, '@'], [3, '@'], [5, '@'], [6, '@'], [8, '@'], [9, '@'], [11, FMT_DATE], [13, '@']]);
    sets.getRange(r, 1, 1, 9).setValues([[n, session, ex.name, ex.amount, ex.unit, ex.per_side, ps.rounds, ex.variant, '']]);
    sets.getRange(r, 10, 1, 3).setFormulas([setsFormulas_(r)]);
    sets.getRange(r, 13).setValue(id);
  });
  syncSummaryExercises_();
  return { ok: true, entry: entryFromLog_(readLog_().filter(function (r) { return r.id === id; })[0]) };
}

function addSport_(req) {
  const activity = String(req.activity || '').toLowerCase();
  if (SPORTS.indexOf(activity) < 0) fail_('bad_request', 'Unknown sport: ' + req.activity);
  const id = cleanId_(req.id) || newId_();
  const dup = readSport_().filter(function (r) { return r.id === id; })[0];
  if (dup) return { ok: true, duplicate: true, entry: entryFromSport_(dup) };
  const now = nowParts_();
  const date = req.date ? checkDate_(req.date) : now.date;
  let duration = '';
  if (req.duration !== undefined && req.duration !== null && req.duration !== '') {
    duration = Number(req.duration);
    if (!(duration >= 1 && duration <= 600) || duration % 1 !== 0) fail_('bad_request', 'Duration must be whole minutes, 1 to 600.');
  }
  const sh = sheet_(TAB.SPORT);
  const row = sh.getLastRow() + 1;
  setFormats_(sh, row, 1, [[1, FMT_DATE], [2, '@'], [4, '@'], [5, FMT_STAMP], [6, '@']]);
  sh.getRange(row, 1, 1, 6).setValues([[dateSerial_(date), activity, duration, cut_(req.note, 2000), stampSerial_(now.date, now.time + ':' + now.sec), id]]);
  sh.getRange(row, 7).setFormula('=IF(A' + row + '="","",' + DAY_FORMULA.replace('%', 'A' + row) + ')');
  return { ok: true, entry: entryFromSport_(readSport_().filter(function (r) { return r.id === id; })[0]) };
}

// ---------------------------------------------------------------- undo and notes

/** The most recent entry that was logged by the app (migrated rows have no logged_at, so they can't be undone). */
function undoTarget_(logs, sport) {
  const all = logs.map(function (r) { return { kind: 'session', id: r.id, loggedAt: r.loggedAt, seq: r.seq, row: r }; })
    .concat(sport.map(function (r) { return { kind: 'sport', id: r.id, loggedAt: r.loggedAt, seq: r.seq, row: r }; }))
    .filter(function (x) { return x.loggedAt; });
  if (!all.length) return null;
  return all.reduce(function (m, x) { return (x.loggedAt > m.loggedAt || (x.loggedAt === m.loggedAt && x.seq > m.seq)) ? x : m; });
}

function undo_(req) {
  const logs = readLog_();
  const sport = readSport_();
  const wanted = cleanId_(req.id);
  const target = undoTarget_(logs, sport);
  const exists = logs.concat(sport).some(function (r) { return r.id === wanted; });
  if (wanted && !exists) return { ok: true, undone: false, message: 'That entry was already removed.' };
  if (!target) fail_('nothing_to_undo', 'There is nothing logged by the app to undo.');
  if (wanted && wanted !== target.id) fail_('not_last', 'That is no longer the last entry, so it was not undone. Edit it in the sheet instead.');
  if (target.kind === 'session') {
    sheet_(TAB.LOG).deleteRow(target.row.row);
    const sets = sheet_(TAB.SETS);
    const last = sets.getLastRow();
    if (last >= 2) {
      const ids = sets.getRange(2, 13, last - 1, 1).getDisplayValues();
      for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] === target.id) sets.deleteRow(i + 2);
    }
    return { ok: true, undone: true, entry: entryFromLog_(target.row) };
  }
  sheet_(TAB.SPORT).deleteRow(target.row.row);
  return { ok: true, undone: true, entry: entryFromSport_(target.row) };
}

function addNote_(req) {
  const id = cleanId_(req.id);
  const text = cut_(req.note, 2000);
  if (!id || !text) fail_('bad_request', 'A note needs an entry id and some text.');
  const log = readLog_().filter(function (r) { return r.id === id; })[0];
  if (log) {
    const sh = sheet_(TAB.LOG);
    sh.getRange(log.row, 13).setNumberFormat('@');
    sh.getRange(log.row, 13).setValue(joinNote_(log.notes, text));
    return { ok: true, entry: entryFromLog_(readLog_().filter(function (r) { return r.id === id; })[0]) };
  }
  const sp = readSport_().filter(function (r) { return r.id === id; })[0];
  if (!sp) fail_('not_found', 'That entry is no longer in the sheet. Refresh the page.');
  const sh = sheet_(TAB.SPORT);
  sh.getRange(sp.row, 4).setNumberFormat('@');
  sh.getRange(sp.row, 4).setValue(joinNote_(sp.notes, text));
  return { ok: true, entry: entryFromSport_(readSport_().filter(function (r) { return r.id === id; })[0]) };
}

function joinNote_(old, add) { return old ? old + ' | ' + add : add; }

// ---------------------------------------------------------------- reading the sheet

/**
 * Reads the Log tab. It deliberately skips the formula columns (session_no, day, week, on_schedule):
 * reading a formula cell can make Google wait for the whole sheet to recalculate, which made the page slow.
 * The label ("A #8") and on_schedule are worked out here instead, with the same rules as the formulas.
 */
function readLog_() {
  const sh = sheet_(TAB.LOG);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const n = last - 1;
  const ab = sh.getRange(2, 1, n, 2).getDisplayValues();
  const dt = sh.getRange(2, 4, n, 3).getDisplayValues();
  const rest = sh.getRange(2, 10, n, 5).getDisplayValues();
  const days = planDays_();
  const out = [];
  for (let i = 0; i < n; i++) {
    if (ab[i][0] === '' && ab[i][1] === '') continue;
    const session = ab[i][1];
    out.push({
      row: i + 2, seq: i, n: Number(ab[i][0]), session: session, date: dt[i][0], time: dt[i][1], loggedAt: dt[i][2],
      onSchedule: dt[i][0] ? (dayName_(dt[i][0]) === days[session] ? 'Yes' : 'No') : '',
      version: rest[i][0], rounds: rest[i][1] === '' ? null : Number(rest[i][1]), tag: rest[i][2], notes: rest[i][3], id: rest[i][4], label: ''
    });
  }
  const count = {};
  out.slice().sort(function (a, b) { return a.n - b.n; }).forEach(function (r) {
    count[r.session] = (count[r.session] || 0) + 1;
    r.label = r.session + ' #' + count[r.session];
  });
  return out;
}

function readSport_() {
  const sh = sheet_(TAB.SPORT);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, 6).getDisplayValues();
  const out = [];
  vals.forEach(function (r, i) {
    if (r[0] === '' && r[1] === '') return;
    out.push({ row: i + 2, seq: i, date: r[0], activity: r[1], duration: r[2] === '' ? null : Number(r[2]), notes: r[3], loggedAt: r[4], id: r[5] });
  });
  return out;
}

/** {A: 'Wed', B: 'Fri', C: 'Mon'} from the small table on the Plan tab (typed cells only). */
function planDays_() {
  const out = {};
  sheet_(TAB.PLAN).getRange(2, 9, 3, 2).getValues().forEach(function (r) {
    const day = DAY_NAMES.filter(function (d) { return d.toLowerCase() === str_(r[1]).slice(0, 3).toLowerCase(); })[0];
    if (str_(r[0]) && day) out[str_(r[0]).toUpperCase()] = day;
  });
  return out;
}

function dayName_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return DAY_NAMES[(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() + 6) % 7];
}

function entryFromLog_(r) {
  return {
    id: r.id, kind: 'session', session: r.session, n: r.n, label: r.label, date: r.date, time: r.time, loggedAt: r.loggedAt,
    version: r.version, rounds: r.rounds, tag: r.tag, notes: r.notes, onSchedule: r.onSchedule, seq: r.seq
  };
}

function entryFromSport_(r) {
  return { id: r.id, kind: 'sport', activity: r.activity, label: r.activity.charAt(0).toUpperCase() + r.activity.slice(1), date: r.date, duration: r.duration, loggedAt: r.loggedAt, notes: r.notes, seq: r.seq };
}

// ---------------------------------------------------------------- plan and plan history

function readPlan_() {
  const sh = sheet_(TAB.PLAN);
  const last = Math.max(sh.getLastRow(), 2);
  const vals = sh.getRange(2, 1, last - 1, 12).getValues();
  const sessions = {};
  vals.forEach(function (r) {
    const s = str_(r[8]).toUpperCase();
    if (SESSIONS.indexOf(s) < 0) return;
    const day = DAY_NAMES.filter(function (d) { return d.toLowerCase() === str_(r[9]).slice(0, 3).toLowerCase(); })[0];
    const rounds = Number(r[10]);
    if (!day) fail_('bad_plan', 'Plan tab: session ' + s + ' needs a day like Mon, Wed or Fri.');
    if (!(rounds >= 1 && rounds <= 50) || rounds % 1 !== 0) fail_('bad_plan', 'Plan tab: session ' + s + ' needs a whole number of rounds.');
    sessions[s] = { day: day, rounds: rounds, version: str_(r[11]), exercises: [] };
  });
  const rows = [];
  vals.forEach(function (r, i) {
    const s = str_(r[0]).toUpperCase();
    if (SESSIONS.indexOf(s) < 0 || str_(r[2]) === '') return;
    if (!sessions[s]) fail_('bad_plan', 'Plan tab: session ' + s + ' has exercises but no day/rounds in the table on the right.');
    const unit = str_(r[4]).toLowerCase();
    if (UNITS.indexOf(unit) < 0) fail_('bad_plan', 'Plan tab: "' + str_(r[2]) + '" needs a unit of reps or sec.');
    const side = str_(r[5]).toLowerCase();
    if (SIDES.indexOf(side) < 0) fail_('bad_plan', 'Plan tab: per_side for "' + str_(r[2]) + '" must be blank, arm, leg or side.');
    const amount = r[3] === '' ? '' : Number(r[3]);
    if (amount !== '' && !(amount > 0)) fail_('bad_plan', 'Plan tab: amount for "' + str_(r[2]) + '" must be a number.');
    rows.push({ s: s, no: r[1] === '' ? i : Number(r[1]), i: i, ex: { name: str_(r[2]), amount: amount, unit: unit, per_side: side, variant: str_(r[6]) } });
  });
  rows.sort(function (a, b) { return a.no - b.no || a.i - b.i; });
  rows.forEach(function (x) { sessions[x.s].exercises.push(x.ex); });
  SESSIONS.forEach(function (s) {
    if (!sessions[s] || !sessions[s].exercises.length) fail_('bad_plan', 'Plan tab: session ' + s + ' has no exercises.');
  });
  return { sessions: sessions };
}

function exLabel_(e) {
  const amt = e.amount === '' ? '' : e.amount + (e.unit === 'sec' ? '-sec ' : ' ');
  return amt + e.name + (e.per_side ? ' each ' + e.per_side : '') + (e.variant ? ' (' + e.variant + ')' : '');
}

function publicPlan_(plan) {
  const out = {};
  SESSIONS.forEach(function (s) {
    const p = plan.sessions[s];
    out[s] = { day: p.day, rounds: p.rounds, version: p.version, exercises: p.exercises.map(exLabel_) };
  });
  return out;
}

function planSignature_(rounds, exercises) {
  return JSON.stringify([Number(rounds), exercises.map(function (e) { return [e.name, String(e.amount), e.unit, e.per_side, e.variant]; })]);
}

/** Versions already in Plan history for one session: [{version, counter, rounds, exercises}] */
function historyVersions_(session) {
  const sh = sheet_(TAB.HISTORY);
  const last = sh.getLastRow();
  const byVersion = {};
  const order = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 11).getValues().forEach(function (r) {
      if (str_(r[1]).toUpperCase() !== session || str_(r[0]) === '') return;
      const v = str_(r[0]);
      if (!byVersion[v]) { byVersion[v] = { version: v, counter: Number(v.slice(1)) || 0, rounds: Number(r[4]), exercises: [] }; order.push(v); }
      byVersion[v].exercises.push({ no: Number(r[5]), name: str_(r[6]), amount: r[7] === '' ? '' : Number(r[7]), unit: str_(r[8]), per_side: str_(r[9]), variant: str_(r[10]) });
    });
  }
  return order.map(function (v) { byVersion[v].exercises.sort(function (a, b) { return a.no - b.no; }); return byVersion[v]; });
}

/**
 * Returns the plan version a session logged today will use. If the Plan tab no longer matches the latest
 * version in Plan history, a new version is saved first (effective from the date of this session).
 */
function ensureVersion_(session, ps, date) {
  const versions = historyVersions_(session);
  const latest = versions.reduce(function (m, v) { return !m || v.counter > m.counter ? v : m; }, null);
  const sig = planSignature_(ps.rounds, ps.exercises);
  if (latest && planSignature_(latest.rounds, latest.exercises) === sig) {
    setPlanVersion_(session, latest.version);
    return latest.version;
  }
  const version = session + ((latest ? latest.counter : 0) + 1);
  appendHistory_(version, session, date, ps);
  setPlanVersion_(session, version);
  return version;
}

function appendHistory_(version, session, date, ps) {
  const sh = sheet_(TAB.HISTORY);
  const first = sh.getLastRow() + 1;
  ps.exercises.forEach(function (e, i) {
    const r = first + i;
    setFormats_(sh, r, 1, [[1, '@'], [2, '@'], [3, FMT_DATE], [4, '@'], [7, '@'], [9, '@'], [10, '@'], [11, '@']]);
    sh.getRange(r, 1, 1, 11).setValues([[version, session, dateSerial_(date), ps.day, ps.rounds, i + 1, e.name, e.amount, e.unit, e.per_side, e.variant]]);
  });
}

function setPlanVersion_(session, version) {
  const sh = sheet_(TAB.PLAN);
  const vals = sh.getRange(2, 9, 3, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (str_(vals[i][0]).toUpperCase() === session) {
      sh.getRange(i + 2, 12).setNumberFormat('@');
      sh.getRange(i + 2, 12).setValue(version);
    }
  }
}

// ---------------------------------------------------------------- formulas (shared by the app and the migration)

function logFormulaSessionNo_(r) {
  return '=IF(B' + r + '="","",B' + r + '&" #"&COUNTIFS(B:B,B' + r + ',A:A,"<="&A' + r + '))';
}
function logFormulasDerived_(r) {
  return [
    '=IF(D' + r + '="","",' + DAY_FORMULA.replace('%', 'D' + r) + ')',
    '=IF(D' + r + '="","",INT((D' + r + '-Settings!$B$3)/7)+1)',
    '=IF(D' + r + '="","",IF(G' + r + '=IFERROR(INDEX(Plan!$J$2:$J$4,MATCH(B' + r + ',Plan!$I$2:$I$4,0)),""),"Yes","No"))'
  ];
}
function setsFormulas_(r) {
  return [
    '=IF(D' + r + '="","",D' + r + '*G' + r + '*IF(F' + r + '="",1,2))',
    '=IFERROR(INDEX(Log!$D:$D,MATCH(A' + r + ',Log!$A:$A,0)),"")',
    '=IFERROR(INDEX(Log!$H:$H,MATCH(A' + r + ',Log!$A:$A,0)),"")'
  ];
}

// ---------------------------------------------------------------- building the tabs

/** Creates the tabs that don't exist yet, with headers, formats, and formulas. Existing tabs are left alone. */
function buildTabs_(ss, programmeStartSerial) {
  const made = {};
  function tab(name, headers) {
    let sh = ss.getSheetByName(name);
    if (sh) return null;
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    made[name] = true;
    return sh;
  }
  let sh = tab(TAB.SETTINGS, ['setting', 'value']);
  if (sh) {
    sh.getRange(2, 1, 2, 2).setValues([['programme_start', programmeStartSerial], ['week1_monday', '']]);
    sh.getRange(2, 2).setNumberFormat(FMT_DATE);
    sh.getRange(3, 2).setFormula('=B2-WEEKDAY(B2,3)');
    sh.getRange(3, 2).setNumberFormat(FMT_DATE);
    sh.getRange(5, 1).setValue('Week 1 is the Monday-to-Sunday week that contains programme_start. Leave week1_monday alone: it is a formula.');
  }
  sh = tab(TAB.LOG, LOG_HEADERS);
  sh = tab(TAB.SETS, SETS_HEADERS);
  sh = tab(TAB.PLAN, PLAN_EX_HEADERS);
  if (sh) {
    sh.getRange(1, 9, 1, 4).setValues([PLAN_SESS_HEADERS]);
    sh.getRange(1, 9, 1, 4).setFontWeight('bold');
  }
  tab(TAB.HISTORY, HISTORY_HEADERS);
  tab(TAB.SPORT, SPORT_HEADERS);
  sh = tab(TAB.BREAKS, BREAKS_HEADERS);
  if (sh) sh.getRange(2, 1, MISSED_ROWS, 2).setNumberFormat(FMT_DATE);
  sh = tab(TAB.MISSED, ['date', 'scheduled', 'status', 'streak']);
  if (sh) buildMissed_(sh);
  sh = tab(TAB.SUMMARY, ['Dad Fit summary']);
  if (sh) buildSummary_(sh);
  return made;
}

function buildMissed_(sh) {
  const f = [];
  for (let r = 2; r < 2 + MISSED_ROWS; r++) {
    f.push([
      r === 2 ? '=Settings!$B$2' : '=A' + (r - 1) + '+1',
      '=IFERROR(INDEX(Plan!$I$2:$I$4,MATCH(' + DAY_FORMULA.replace('%', 'A' + r) + ',Plan!$J$2:$J$4,0)),"")',
      '=IF(B' + r + '="","",IF(COUNTIFS(Log!$D:$D,A' + r + ')>0,"Done",IF(A' + r + '>=TODAY(),"",IF(COUNTIFS(Breaks!$A:$A,"<="&A' + r + ',Breaks!$B:$B,">="&A' + r + ')>0,"Break","Missed"))))',
      '=IF(C' + r + '="Done",N(D' + (r - 1) + ')+1,IF(C' + r + '="Missed",0,N(D' + (r - 1) + ')))'
    ]);
  }
  sh.getRange(2, 1, MISSED_ROWS, 4).setFormulas(f);
  sh.getRange(2, 1, MISSED_ROWS, 1).setNumberFormat(FMT_DATE);
}

function buildSummary_(sh) {
  const need = 1 + SUMMARY_WEEKS; // a new tab has 26 columns; the progression grid needs one per week plus the name
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  sh.getRange(1, 1).setFontWeight('bold');
  const put = function (r, c, v) { sh.getRange(r, c).setFormula(v); };
  const lit = function (r, c, v) { sh.getRange(r, c).setValue(v); sh.getRange(r, c).setFontWeight('bold'); };

  lit(3, 1, 'Overall');
  const overall = [
    ['Kettlebell sessions', '=COUNT(Log!A:A)'],
    ['Last session', '=IF(B4=0,"",INDEX(Log!C:C,MATCH(MAX(Log!A:A),Log!A:A,0)))'],
    ['Last session date', '=IF(B4=0,"",INDEX(Log!D:D,MATCH(MAX(Log!A:A),Log!A:A,0)))'],
    ['Current streak (scheduled sessions in a row, breaks skipped)', '=IFERROR(INDEX(Missed!D:D,MATCH(TODAY(),Missed!A:A,0)),0)'],
    ['Longest streak', '=MAX(Missed!D:D)'],
    ['Missed sessions', '=COUNTIF(Missed!C:C,"Missed")'],
    ['Skipped in planned breaks', '=COUNTIF(Missed!C:C,"Break")'],
    ['Programme week now', '=INT((TODAY()-Settings!$B$3)/7)+1'],
    ['Sessions this week', '=COUNTIF(Log!H:H,B11)'],
    ['Done on the scheduled day', '=COUNTIF(Log!I:I,"Yes")&" of "&B4'],
    ['Sport sessions (not counted as workouts)', '=COUNTA(Sport!B:B)-1']
  ];
  overall.forEach(function (x, i) { sh.getRange(4 + i, 1).setValue(x[0]); put(4 + i, 2, x[1]); });
  sh.getRange(6, 2).setNumberFormat(FMT_DATE);

  const head = function (r, c, arr) { arr.forEach(function (t, i) { lit(r, c + i, t); }); };
  head(3, 4, ['Session', 'Done', 'Last done', 'Rounds / minutes', 'Plan now']);
  ['A', 'B', 'C'].forEach(function (s, i) {
    const r = 4 + i;
    sh.getRange(r, 4).setValue(s);
    put(r, 5, '=COUNTIF(Log!B:B,D' + r + ')');
    put(r, 6, '=IF(E' + r + '=0,"",MAXIFS(Log!D:D,Log!B:B,D' + r + '))');
    put(r, 7, '=SUMIF(Log!B:B,D' + r + ',Log!K:K)');
    put(r, 8, '=IFERROR(INDEX(Plan!$L$2:$L$4,MATCH(D' + r + ',Plan!$I$2:$I$4,0)),"")');
    sh.getRange(r, 6).setNumberFormat(FMT_DATE);
  });
  SPORTS.forEach(function (s, i) {
    const r = 7 + i;
    sh.getRange(r, 4).setValue(s);
    put(r, 5, '=COUNTIF(Sport!B:B,D' + r + ')');
    put(r, 6, '=IF(E' + r + '=0,"",MAXIFS(Sport!A:A,Sport!B:B,D' + r + '))');
    put(r, 7, '=SUMIF(Sport!B:B,D' + r + ',Sport!C:C)');
    sh.getRange(r, 6).setNumberFormat(FMT_DATE);
  });

  head(3, 10, ['Week', 'Starts', 'Kettlebell', 'Sport']);
  for (let w = 1; w <= SUMMARY_WEEKS; w++) {
    const r = 3 + w;
    sh.getRange(r, 10).setValue(w);
    put(r, 11, '=Settings!$B$3+7*(J' + r + '-1)');
    put(r, 12, '=COUNTIF(Log!H:H,J' + r + ')');
    put(r, 13, '=COUNTIFS(Sport!A:A,">="&K' + r + ',Sport!A:A,"<"&K' + r + '+7)');
    sh.getRange(r, 11).setNumberFormat(FMT_DATE);
  }

  lit(17, 1, 'Exercise volume');
  head(18, 1, ['Exercise', 'Unit', 'Times done', 'Total (reps, or minutes if timed)', 'Latest amount', 'Best amount']);
  for (let i = 0; i < SUMMARY_EX_ROWS; i++) {
    const r = SUMMARY_EX_FIRST + i;
    put(r, 2, '=IF($A' + r + '="","",IFERROR(INDEX(Sets!E:E,MATCH($A' + r + ',Sets!C:C,0)),""))');
    put(r, 3, '=IF($A' + r + '="","",COUNTIF(Sets!C:C,$A' + r + '))');
    put(r, 4, '=IF($A' + r + '="","",SUMIF(Sets!C:C,$A' + r + ',Sets!J:J)/IF(B' + r + '="sec",60,1))');
    put(r, 5, '=IF($A' + r + '="","",SUMIFS(Sets!D:D,Sets!C:C,$A' + r + ',Sets!A:A,MAXIFS(Sets!A:A,Sets!C:C,$A' + r + ')))');
    put(r, 6, '=IF($A' + r + '="","",MAXIFS(Sets!D:D,Sets!C:C,$A' + r + '))');
  }

  const pr = SUMMARY_EX_FIRST + SUMMARY_EX_ROWS + 3;
  lit(pr - 2, 1, 'Progression: best amount per programme week (reps, or seconds if timed)');
  lit(pr - 1, 1, 'Exercise');
  for (let w = 1; w <= SUMMARY_WEEKS; w++) { lit(pr - 1, 1 + w, w); }
  for (let i = 0; i < SUMMARY_EX_ROWS; i++) {
    const r = pr + i;
    put(r, 1, '=IF(A' + (SUMMARY_EX_FIRST + i) + '="","",A' + (SUMMARY_EX_FIRST + i) + ')');
    for (let w = 1; w <= SUMMARY_WEEKS; w++) {
      const col = colLetter_(1 + w);
      put(r, 1 + w, '=IF($A' + r + '="","",IF(COUNTIFS(Sets!$C:$C,$A' + r + ',Sets!$L:$L,' + col + '$' + (pr - 1) + ')=0,"",MAXIFS(Sets!$D:$D,Sets!$C:$C,$A' + r + ',Sets!$L:$L,' + col + '$' + (pr - 1) + ')))');
    }
  }
}

/** Keeps the exercise names on the Summary tab in step with the Sets tab (names are the only typed values there). */
function syncSummaryExercises_() {
  const sets = sheet_(TAB.SETS);
  const last = sets.getLastRow();
  const names = [];
  if (last >= 2) sets.getRange(2, 3, last - 1, 1).getValues().forEach(function (r) { const n = str_(r[0]); if (n && names.indexOf(n) < 0) names.push(n); });
  if (names.length > SUMMARY_EX_ROWS) fail_('too_many_exercises', 'The Summary tab has room for ' + SUMMARY_EX_ROWS + ' exercises.');
  const sh = sheet_(TAB.SUMMARY);
  const cur = sh.getRange(SUMMARY_EX_FIRST, 1, SUMMARY_EX_ROWS, 1).getValues().map(function (r) { return str_(r[0]); }).filter(Boolean);
  const merged = cur.filter(function (n) { return names.indexOf(n) >= 0; });
  names.forEach(function (n) { if (merged.indexOf(n) < 0) merged.push(n); });
  if (merged.join('|') === cur.join('|')) return;
  const col = [];
  for (let i = 0; i < SUMMARY_EX_ROWS; i++) col.push([merged[i] || '']);
  sh.getRange(SUMMARY_EX_FIRST, 1, SUMMARY_EX_ROWS, 1).setValues(col);
}

// ---------------------------------------------------------------- helpers

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) fail_('not_set_up', 'There is no tab called "' + name + '". Run migrate in the Apps Script editor (see README).');
  return sh;
}

function setFormats_(sh, row, nrows, pairs) {
  pairs.forEach(function (p) { sh.getRange(row, p[0], nrows, 1).setNumberFormat(p[1]); });
}

function fail_(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function newId_() { return 'w' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function cleanId_(v) { const s = String(v == null ? '' : v).trim(); return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : ''; }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function cut_(v, n) { return str_(v).slice(0, n); }
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function nowParts_() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const d = new Date();
  return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(d, tz, 'HH:mm'), sec: Utilities.formatDate(d, tz, 'ss') };
}

function checkDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) fail_('bad_request', 'Date must look like 2026-09-30.');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) fail_('bad_request', 'That date does not exist: ' + s);
  return String(s);
}
function checkTime_(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 23 || +m[2] > 59) fail_('bad_request', 'Time must look like 07:30.');
  return String(s);
}

// Sheet date/time cells hold numbers: days since 1899-12-30, with the time of day as a fraction.
function dateSerial_(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 25569; }
function timeSerial_(s) { const m = /^(\d{2}):(\d{2})$/.exec(s); return (+m[1] * 60 + +m[2]) / 1440; }
function stampSerial_(date, hms) { const p = hms.split(':'); return dateSerial_(date) + (+p[0] * 3600 + +p[1] * 60 + +(p[2] || 0)) / 86400; }
