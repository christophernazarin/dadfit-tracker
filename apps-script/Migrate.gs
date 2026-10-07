/**
 * ONE-TIME migration. Run it once, on a COPY of your sheet (File > Make a copy), from the Apps Script
 * editor: pick "migrate" in the function list and press Run. You can delete this file afterwards.
 *
 * What it does:
 *   1. Finds your existing tab (the one whose first row is workout_no, date, time, session, ...).
 *   2. Renames it "Old log (backup)". Its contents are never changed or deleted.
 *   3. Creates the new tabs (Log, Sets, Plan, Plan history, Sport, Breaks, Missed, Summary, Settings).
 *   4. Fills them from your old rows: kettlebell workouts to Log, one row per exercise to Sets,
 *      rugby/badminton to Sport, and the plan versions worked out from the exercises you recorded.
 *
 * It stops with a plain message, and changes nothing, if something does not look right.
 */

const OLD_HEADERS = ['workout_no', 'date', 'time', 'session', 'label', 'rounds', 'exercises', 'notes'];
const BACKUP_NAME = 'Old log (backup)';
const DEFAULT_DAYS = { C: 'Mon', A: 'Wed', B: 'Fri' };
const BREAKS_TO_ADD = [['2026-08-30', '2026-09-13', 'Planned break, no kettlebell']];

const NAMES = {
  'goblet squats': 'goblet squat', 'push-ups': 'push-up', 'single-arm kb rows': 'single-arm KB row',
  'romanian deadlifts': 'Romanian deadlift', 'plank': 'plank', 'suitcase carry': 'suitcase carry',
  'goblet reverse lunges': 'goblet reverse lunge', 'clean & press': 'clean & press',
  'kb swings': 'KB swing', 'mountain climbers': 'mountain climber'
};
const TIMED = ['plank', 'suitcase carry'];

function migrate() {
  const ss = SpreadsheetApp.getActive();
  const old = findOldTab_(ss);
  const plan = migrationPlan_(readOld_(old));
  Logger.log(plan.report.join('\n'));

  old.setName(BACKUP_NAME);
  const startSerial = dateSerial_(plan.programmeStart);
  buildTabs_(ss, startSerial);

  // Log
  const log = ss.getSheetByName(TAB.LOG);
  const n = plan.workouts.length;
  if (n) {
    log.getRange(2, 4, n, 1).setNumberFormat(FMT_DATE);
    log.getRange(2, 5, n, 1).setNumberFormat(FMT_TIME);
    log.getRange(2, 10, n, 5).setNumberFormat('@');
    log.getRange(2, 1, n, 2).setValues(plan.workouts.map(function (w) { return [w.n, w.session]; }));
    log.getRange(2, 3, n, 1).setFormulas(plan.workouts.map(function (w, i) { return [logFormulaSessionNo_(i + 2)]; }));
    log.getRange(2, 4, n, 2).setValues(plan.workouts.map(function (w) { return [dateSerial_(w.date), w.time ? timeSerial_(w.time) : '']; }));
    log.getRange(2, 7, n, 3).setFormulas(plan.workouts.map(function (w, i) { return logFormulasDerived_(i + 2); }));
    log.getRange(2, 10, n, 5).setValues(plan.workouts.map(function (w) { return [w.version, w.rounds, w.label, w.notes, w.id]; }));
  }

  // Sets
  const sets = ss.getSheetByName(TAB.SETS);
  const m = plan.sets.length;
  if (m) {
    [2, 3, 5, 6, 8, 9, 13].forEach(function (c) { sets.getRange(2, c, m, 1).setNumberFormat('@'); });
    sets.getRange(2, 11, m, 1).setNumberFormat(FMT_DATE);
    sets.getRange(2, 1, m, 9).setValues(plan.sets.map(function (s) { return [s.n, s.session, s.name, s.amount, s.unit, s.per_side, s.rounds, s.variant, s.note]; }));
    sets.getRange(2, 10, m, 3).setFormulas(plan.sets.map(function (s, i) { return setsFormulas_(i + 2); }));
    sets.getRange(2, 13, m, 1).setValues(plan.sets.map(function (s) { return [s.id]; }));
  }

  // Sport
  const sport = ss.getSheetByName(TAB.SPORT);
  const k = plan.sport.length;
  if (k) {
    sport.getRange(2, 1, k, 1).setNumberFormat(FMT_DATE);
    sport.getRange(2, 2, k, 1).setNumberFormat('@');
    sport.getRange(2, 4, k, 1).setNumberFormat('@');
    sport.getRange(2, 6, k, 1).setNumberFormat('@');
    sport.getRange(2, 1, k, 4).setValues(plan.sport.map(function (s) { return [dateSerial_(s.date), s.activity, s.duration, s.notes]; }));
    sport.getRange(2, 6, k, 1).setValues(plan.sport.map(function (s) { return [s.id]; }));
    sport.getRange(2, 7, k, 1).setFormulas(plan.sport.map(function (s, i) { return ['=IF(A' + (i + 2) + '="","",' + DAY_FORMULA.replace('%', 'A' + (i + 2)) + ')']; }));
  }

  // Plan (current = latest version of each session) and Plan history (all versions)
  const planSh = ss.getSheetByName(TAB.PLAN);
  const exRows = [];
  const sessRows = [];
  ['A', 'B', 'C'].forEach(function (s) {
    const cur = plan.versions[s][plan.versions[s].length - 1];
    cur.exercises.forEach(function (e, i) { exRows.push([s, i + 1, e.name, e.amount, e.unit, e.per_side, e.variant]); });
    sessRows.push([s, DEFAULT_DAYS[s], cur.rounds, cur.version]);
  });
  planSh.getRange(2, 1, exRows.length, 7).setNumberFormat('@');
  planSh.getRange(2, 4, exRows.length, 1).setNumberFormat('General');
  planSh.getRange(2, 2, exRows.length, 1).setNumberFormat('General');
  planSh.getRange(2, 1, exRows.length, 7).setValues(exRows);
  planSh.getRange(2, 9, 3, 2).setNumberFormat('@');
  planSh.getRange(2, 12, 3, 1).setNumberFormat('@');
  planSh.getRange(2, 9, 3, 4).setValues(sessRows);

  ['A', 'B', 'C'].forEach(function (s) {
    plan.versions[s].forEach(function (v) {
      appendHistory_(v.version, s, v.from, { day: DEFAULT_DAYS[s], rounds: v.rounds, exercises: v.exercises });
    });
  });

  // Breaks
  const br = ss.getSheetByName(TAB.BREAKS);
  BREAKS_TO_ADD.forEach(function (b, i) {
    br.getRange(2 + i, 1, 1, 3).setValues([[dateSerial_(b[0]), dateSerial_(b[1]), b[2]]]);
  });

  syncSummaryExercises_();
  Logger.log('DONE. Your original tab is now called "' + BACKUP_NAME + '" and is untouched. Now check the Summary tab against the numbers above.');
}

// ---------------------------------------------------------------- reading the old tab

function findOldTab_(ss) {
  if (ss.getSheetByName(TAB.SETS) || ss.getSheetByName(TAB.PLAN)) {
    throw new Error('This sheet already has new-style tabs (Sets or Plan). Migrate only works on a copy of the original single-tab sheet. Nothing was changed.');
  }
  const found = ss.getSheets().filter(function (sh) {
    if (sh.getLastRow() < 1 || sh.getLastColumn() < 8) return false;
    const head = sh.getRange(1, 1, 1, 8).getValues()[0].map(function (v) { return String(v).trim(); });
    return head.join(',') === OLD_HEADERS.join(',');
  });
  if (found.length !== 1) throw new Error('Expected exactly one tab whose first row is: ' + OLD_HEADERS.join(', ') + '. Found ' + found.length + '. Nothing was changed.');
  return found[0];
}

function readOld_(sh) {
  const last = sh.getLastRow();
  const raw = sh.getRange(2, 1, Math.max(last - 1, 1), 8).getValues();
  const shown = sh.getRange(2, 1, Math.max(last - 1, 1), 8).getDisplayValues();
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const rows = [];
  raw.forEach(function (r, i) {
    if (r.every(function (v) { return v === '' || v === null; })) return;
    rows.push({
      line: i + 2,
      n: r[0] === '' ? null : Number(r[0]),
      date: oldDate_(r[1], shown[i][1], tz, i + 2),
      time: oldTime_(r[2], shown[i][2]),
      session: String(r[3]).trim(),
      label: String(r[4]).trim(),
      rounds: r[5] === '' ? null : Number(r[5]),
      exercises: String(r[6]).trim(),
      notes: String(r[7]).trim()
    });
  });
  return rows;
}

function oldDate_(raw, shown, tz, line) {
  if (Object.prototype.toString.call(raw) === '[object Date]') return Utilities.formatDate(raw, tz, 'yyyy-MM-dd');
  const s = String(shown || raw).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // day/month/year (day/month/year order)
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  throw new Error('Old tab, row ' + line + ': cannot read the date "' + s + '". Nothing was changed.');
}

function oldTime_(raw, shown) {
  const s = String(shown || '').trim();
  if (s === '') return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) throw new Error('Cannot read the time "' + s + '". Nothing was changed.');
  return ('0' + m[1]).slice(-2) + ':' + m[2];
}

// ---------------------------------------------------------------- working out the new structure (pure; tested offline)

/** "12 single-arm KB rows each arm (split-stance)" -> {name, amount, unit, per_side, variant, note} */
function parseExercise_(text) {
  let s = String(text).trim();
  let variant = '';
  const notes = [];
  let m = /\s*\(([^)]*)\)\s*$/.exec(s);
  if (m) {
    s = s.slice(0, m.index);
    if (/^split-stance$/i.test(m[1].trim())) variant = 'split-stance'; else notes.push(m[1].trim());
  }
  if (s.charAt(0) === '~') { notes.unshift('approx'); s = s.slice(1); }
  let side = '';
  m = /\s+each\s+(arm|leg|side)\s*$/i.exec(s);
  if (m) { side = m[1].toLowerCase(); s = s.slice(0, m.index); }
  let amount = '';
  let unit = '';
  m = /^(\d+)(-sec)?\s+(.*)$/.exec(s);
  if (m) { amount = Number(m[1]); unit = m[2] ? 'sec' : ''; s = m[3]; }
  const key = s.trim().toLowerCase();
  const name = NAMES[key] || s.trim();
  if (!unit) unit = TIMED.indexOf(name) >= 0 ? 'sec' : 'reps';
  return { name: name, amount: amount, unit: unit, per_side: side, variant: variant, note: notes.join('; '), known: !!NAMES[key] };
}

function splitExercises_(text) {
  return text ? text.split('|').map(function (x) { return x.trim(); }).filter(Boolean).map(parseExercise_) : [];
}

/**
 * Turns the old rows into the new tables. Pure function: no sheet access.
 * Rules (agreed with the owner):
 *  - rows with a session of A, B or C are workouts; rugby/badminton rows go to Sport.
 *  - plan versions are rebuilt from the exercises: each time a session's prescription changes it gets the next version.
 *  - a workout with no exercises/rounds (#20) is assumed to follow the plan version current for that session.
 */
function migrationPlan_(rows) {
  const report = [];
  const workouts = [];
  const sets = [];
  const sport = [];
  const versions = { A: [], B: [], C: [] };
  const problems = [];
  const mkid = newId_;

  rows.forEach(function (r) {
    const s = r.session.toLowerCase();
    if (SPORTS.indexOf(s) >= 0) {
      let dur = '';
      let m = /(\d+)\s*min/i.exec(r.notes);
      if (m) dur = Number(m[1]);
      else if ((m = /(\d+)\s*(?:hr|hour)/i.exec(r.notes))) dur = Number(m[1]) * 60;
      sport.push({ date: r.date, activity: s, duration: dur, notes: r.notes, id: mkid() });
    }
  });

  const kb = rows.filter(function (r) { return ['A', 'B', 'C'].indexOf(r.session.toUpperCase()) >= 0; });
  kb.sort(function (a, b) { return (a.n || 0) - (b.n || 0); });
  kb.forEach(function (r) {
    const session = r.session.toUpperCase();
    if (!r.n) problems.push('Row ' + r.line + ': a ' + session + ' session has no workout number.');
    const cur = versions[session];
    const prev = cur.length ? cur[cur.length - 1] : null;
    let exercises = splitExercises_(r.exercises);
    let rounds = r.rounds;
    let assumed = false;
    if (!exercises.length || !rounds) {
      if (!prev) { problems.push('Row ' + r.line + ': workout #' + r.n + ' has no exercises or rounds and there is no earlier ' + session + ' to copy.'); return; }
      if (!exercises.length) { exercises = prev.exercises.map(function (e) { return Object.assign({ note: '', known: true }, e); }); assumed = true; }
      if (!rounds) { rounds = prev.rounds; assumed = true; }
    }
    exercises.forEach(function (e) { if (!e.known) problems.push('Workout #' + r.n + ': unrecognised exercise "' + e.name + '" (kept as typed).'); });
    const sig = planSignature_(rounds, exercises);
    let ver = prev && planSignature_(prev.rounds, prev.exercises) === sig ? prev : null;
    if (!ver) {
      ver = { version: session + (cur.length + 1), from: r.date, rounds: rounds, exercises: exercises.map(function (e) { return { name: e.name, amount: e.amount, unit: e.unit, per_side: e.per_side, variant: e.variant }; }), first: r.n };
      cur.push(ver);
    }
    const id = mkid();
    workouts.push({ n: r.n, session: session, date: r.date, time: r.time, version: ver.version, rounds: rounds, label: r.label, notes: r.notes, id: id });
    exercises.forEach(function (e) {
      sets.push({
        n: r.n, session: session, name: e.name, amount: e.amount, unit: e.unit, per_side: e.per_side, rounds: rounds, variant: e.variant,
        note: assumed ? (e.note ? e.note + '; ' : '') + 'assumed from plan ' + ver.version + ' (not recorded)' : e.note, id: id
      });
    });
  });

  if (problems.length) throw new Error('Nothing was changed. Please fix these in the old tab first:\n' + problems.join('\n'));

  const dates = rows.map(function (r) { return r.date; }).sort();
  report.push('About to migrate (nothing written yet):');
  report.push('  workouts: ' + workouts.length + ' (' + workouts.map(function (w) { return w.n; }).join(',') + ')');
  report.push('  exercise rows (Sets): ' + sets.length);
  report.push('  sport rows: ' + sport.length);
  ['A', 'B', 'C'].forEach(function (s) { report.push('  plan versions ' + s + ': ' + versions[s].map(function (v) { return v.version + ' from ' + v.from; }).join(', ')); });
  return { workouts: workouts, sets: sets, sport: sport, versions: versions, programmeStart: dates[0], report: report };
}

// ---------------------------------------------------------------- backfill (optional, run after migrate)

/** Sessions you did but never logged. Edit this list, then run "backfill". Safe to run twice (it skips ones already added). */
const BACKFILL = [
  { session: 'C', date: '2026-10-05' }
];

function backfill() {
  BACKFILL.forEach(function (b) {
    const r = addSession_({ session: b.session, date: b.date, time: '', id: 'backfill-' + b.date + '-' + b.session });
    Logger.log((r.duplicate ? 'Already there: ' : 'Added: ') + r.entry.label + ' on ' + r.entry.date);
  });
}
