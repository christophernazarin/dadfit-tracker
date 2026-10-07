// Run: node dev/test-backend.js
// Tests apps-script/Code.gs and Migrate.gs against a simulated sheet that calculates formulas.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createBackend } = require('./mock-sheet');
const CSV = path.join(__dirname, 'dadfit-log.csv');
let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('FAIL ' + name + '\n     ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n     ')); }
};

// ---- independent reading of the CSV, used to check the migration against the source of truth
const csvRows = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
function csvParse(text) { // small RFC-4180 parser
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const src = csvParse(fs.readFileSync(CSV, 'utf8')).slice(1).map((r) => ({ n: r[0], date: r[1], time: r[2], session: r[3], label: r[4], rounds: r[5], exercises: r[6], notes: r[7] }));
const kbSrc = src.filter((r) => /^[ABC]$/.test(r.session));
const sportSrc = src.filter((r) => !/^[ABC]$/.test(r.session));

// =============================================================== exercise parser
{
  const b = createBackend();
  const p = (s) => b.run('parseExercise_', s);
  test('parser: reps, per side, variant, timed, approximate', () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p('12 single-arm KB rows each arm (split-stance)'))), { name: 'single-arm KB row', amount: 12, unit: 'reps', per_side: 'arm', variant: 'split-stance', note: '', known: true });
    const plank = p('60-sec plank'); assert.deepStrictEqual([plank.name, plank.amount, plank.unit], ['plank', 60, 'sec']);
    const carry = p('75-sec suitcase carry each side'); assert.deepStrictEqual([carry.name, carry.amount, carry.unit, carry.per_side], ['suitcase carry', 75, 'sec', 'side']);
    const none = p('Suitcase carry each side'); assert.deepStrictEqual([none.name, none.amount, none.unit, none.per_side], ['suitcase carry', '', 'sec', 'side']);
    const cp = p('~10 clean & press each arm (8 in final round)'); assert.deepStrictEqual([cp.name, cp.amount, cp.per_side, cp.note], ['clean & press', 10, 'arm', 'approx; 8 in final round']);
    assert.strictEqual(p('20 KB swings').name, 'KB swing');
    assert.strictEqual(p('12 mountain climbers each leg').per_side, 'leg');
  });
  test('parser: every exercise in the CSV is recognised', () => {
    kbSrc.forEach((r) => r.exercises.split('|').map((x) => x.trim()).filter(Boolean).forEach((x) => assert.ok(p(x).known, 'not recognised: ' + x)));
  });
}

// =============================================================== migration, both import styles
for (const mode of ['text', 'dates']) {
  const b = createBackend({ csvFile: CSV, mode });
  const old = () => JSON.stringify(b.tab('Sheet1') ? b.grid('Sheet1') : b.grid('Old log (backup)'));
  const before = old();
  test(`[${mode}] migrate runs`, () => { b.run('migrate'); assert.ok(b.logs.join('\n').includes('DONE')); });
  test(`[${mode}] original tab is kept, renamed, and unchanged`, () => {
    assert.ok(b.tab('Old log (backup)')); assert.ok(!b.tab('Sheet1'));
    assert.strictEqual(old(), before);
  });
  test(`[${mode}] all new tabs exist`, () => {
    ['Log', 'Sets', 'Plan', 'Plan history', 'Sport', 'Breaks', 'Missed', 'Summary', 'Settings'].forEach((t) => assert.ok(b.tab(t), 'missing ' + t));
  });
  test(`[${mode}] migrate refuses to run twice`, () => {
    assert.throws(() => b.run('migrate'), /already has new-style tabs/);
  });
  test(`[${mode}] Log has all 20 workouts with the right data`, () => {
    const g = b.grid('Log');
    assert.deepStrictEqual(g[0], ['workout_no', 'session', 'session_no', 'date', 'start_time', 'logged_at', 'day', 'week', 'on_schedule', 'plan_version', 'rounds', 'label', 'notes', 'id']);
    const rows = g.slice(1);
    assert.strictEqual(rows.length, 20);
    kbSrc.forEach((s, i) => {
      const r = rows[i];
      assert.strictEqual(r[0], s.n); assert.strictEqual(r[1], s.session); assert.strictEqual(r[3], s.date);
      assert.strictEqual(r[4], s.time); assert.strictEqual(r[11], s.label); assert.strictEqual(r[12], s.notes);
      assert.ok(r[13]);
    });
  });
  test(`[${mode}] derived Log columns are right (session #, day, week, on schedule)`, () => {
    const rows = b.grid('Log').slice(1);
    const w19 = rows[18]; // A on Wed 23 Sep
    assert.deepStrictEqual([w19[2], w19[6], w19[7], w19[8]], ['A #7', 'Wed', '9', 'Yes']);
    assert.deepStrictEqual([rows[0][2], rows[0][7]], ['A #1', '1']);
    assert.strictEqual(rows[13][2], 'B #5'); // workout 14
    assert.ok(rows.every((r) => r[8] === 'Yes'), 'every old session was on its scheduled day');
    assert.strictEqual(rows[19][2], 'B #7'); // workout 20
  });
  test(`[${mode}] Sport rows moved across with durations`, () => {
    const rows = b.grid('Sport').slice(1);
    assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual(rows.map((r) => [r[0], r[1], r[2], r[6]]), [['2026-08-03', 'rugby', '45', 'Mon'], ['2026-09-13', 'badminton', '60', 'Sun'], ['2026-09-14', 'rugby', '', 'Mon'], ['2026-09-21', 'rugby', '', 'Mon']]);
    sportSrc.forEach((s, i) => assert.strictEqual(rows[i][3], s.notes));
  });
  test(`[${mode}] Sets: 80 rows, each linked to its workout, totals by formula`, () => {
    const rows = b.grid('Sets').slice(1);
    assert.strictEqual(rows.length, 80);
    const w7 = rows.filter((r) => r[0] === '7');
    assert.deepStrictEqual(w7.map((r) => [r[2], r[3], r[4], r[5], r[6], r[9]]), [
      ['goblet squat', '12', 'reps', '', '4', '48'], ['push-up', '10', 'reps', '', '4', '40'],
      ['single-arm KB row', '12', 'reps', 'arm', '4', '96'], ['Romanian deadlift', '12', 'reps', '', '4', '48'], ['plank', '60', 'sec', '', '4', '240']]);
    assert.strictEqual(w7[0][10], '2026-08-12'); assert.strictEqual(w7[0][11], '3'); // week 1 starts Mon 27 Jul, so 12 Aug is week 3
    const w2 = rows.filter((r) => r[0] === '2');
    assert.deepStrictEqual([w2[0][2], w2[0][3], w2[0][9]], ['suitcase carry', '', '']); // no duration recorded: left blank, not guessed
    assert.deepStrictEqual([w2[2][3], w2[2][8]], ['10', 'approx; 8 in final round']);
    const w20 = rows.filter((r) => r[0] === '20');
    assert.strictEqual(w20.length, 3);
    assert.ok(w20.every((r) => /assumed from plan B5/.test(r[8])));
    assert.deepStrictEqual([w20[0][3], w20[0][6]], ['75', '4']);
  });
  test(`[${mode}] Log row for #20 gets the assumed rounds and plan version, notes untouched`, () => {
    const r = b.grid('Log')[20];
    assert.deepStrictEqual([r[9], r[10], r[12]], ['B5', '4', '']);
  });
  test(`[${mode}] plan versions rebuilt from the log`, () => {
    const h = b.grid('Plan history').slice(1);
    const versions = {};
    h.forEach((r) => { (versions[r[0]] = versions[r[0]] || { from: r[2], n: 0 }).n++; });
    assert.deepStrictEqual(Object.keys(versions).sort(), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4']);
    assert.strictEqual(versions.A1.from, '2026-07-29'); assert.strictEqual(versions.A2.from, '2026-08-12');
    assert.strictEqual(versions.A3.from, '2026-08-26'); assert.strictEqual(versions.A4.from, '2026-09-16'); assert.strictEqual(versions.A5.from, '2026-09-23');
    assert.strictEqual(versions.B2.from, '2026-08-05'.replace('05', '07')); // first B with 8 clean & presses is #5 on 7 Aug
    assert.strictEqual(versions.B5.from, '2026-09-18');
    assert.strictEqual(versions.C3.from, '2026-09-14'); assert.strictEqual(versions.C4.from, '2026-09-21');
    // every Log row's version really matches the exercises recorded for it
    const log = b.grid('Log').slice(1);
    const sets = b.grid('Sets').slice(1);
    log.forEach((l) => {
      const used = sets.filter((s) => s[0] === l[0]).map((s) => [s[2], s[3], s[4], s[5], s[7]].join('/'));
      const hist = h.filter((x) => x[0] === l[9]).map((x) => [x[6], x[7], x[8], x[9], x[10]].join('/'));
      assert.deepStrictEqual(used, hist, 'workout ' + l[0] + ' vs ' + l[9]);
    });
  });
  test(`[${mode}] Plan holds the latest version of each session, with day and rounds`, () => {
    const g = b.grid('Plan');
    assert.deepStrictEqual(g.slice(1, 4).map((r) => r.slice(8, 12)), [['A', 'Wed', '4', 'A5'], ['B', 'Fri', '4', 'B5'], ['C', 'Mon', '4', 'C4']]);
    assert.strictEqual(g.slice(1).filter((r) => r[0] === 'A').length, 5);
  });
  test(`[${mode}] Breaks has the planned break; Missed shows 6 breaks, 0 misses, streak 20 (as at 26 Sep)`, () => {
    assert.deepStrictEqual(b.grid('Breaks')[1], ['2026-08-30', '2026-09-13', 'Planned break, no kettlebell']);
    const m = b.grid('Missed').slice(1);
    const count = (s) => m.filter((r) => r[2] === s).length;
    assert.deepStrictEqual([count('Done'), count('Break'), count('Missed')], [20, 6, 0]);
    assert.deepStrictEqual(m.filter((r) => r[2] === 'Break').map((r) => r[0]), ['2026-08-31', '2026-09-02', '2026-09-04', '2026-09-07', '2026-09-09', '2026-09-11']);
    assert.strictEqual(m[0][0], '2026-07-29');
  });
  test(`[${mode}] Summary matches numbers worked out independently from the CSV`, () => {
    const g = b.grid('Summary');
    const find = (label) => g.find((r) => r[0] === label);
    assert.strictEqual(find('Kettlebell sessions')[1], '20');
    assert.strictEqual(find('Last session')[1], 'B #7');
    assert.strictEqual(find('Last session date')[1], '2026-09-25');
    assert.strictEqual(find('Current streak (scheduled sessions in a row, breaks skipped)')[1], '20');
    assert.strictEqual(find('Longest streak')[1], '20');
    assert.strictEqual(find('Missed sessions')[1], '0');
    assert.strictEqual(find('Skipped in planned breaks')[1], '6');
    assert.strictEqual(find('Programme week now')[1], '9'); // 26 Sep 2026 is in the week of Mon 21 Sep
    assert.strictEqual(find('Sessions this week')[1], '3');
    assert.strictEqual(find('Done on the scheduled day')[1], '20 of 20');
    assert.strictEqual(find('Sport sessions (not counted as workouts)')[1], '4');
    // by session
    const sess = (s) => g.find((r) => r[3] === s);
    assert.deepStrictEqual(sess('A').slice(4, 8), ['7', '2026-09-23', '28', 'A5']);
    assert.deepStrictEqual(sess('B').slice(4, 8), ['7', '2026-09-25', '28', 'B5']);
    assert.deepStrictEqual(sess('C').slice(4, 8), ['6', '2026-09-21', '24', 'C4']);
    assert.deepStrictEqual(sess('rugby').slice(4, 7), ['3', '2026-09-21', '45']);
    assert.deepStrictEqual(sess('badminton').slice(4, 7), ['1', '2026-09-13', '60']);
    // exercise volume: re-derived straight from the CSV text
    const sum = (re, secs) => {
      let t = 0;
      kbSrc.forEach((r) => { if (!r.exercises) return; const m = new RegExp('(\\d+)(?:-sec)? ' + re).exec(r.exercises); if (m) t += Number(m[1]) * Number(r.rounds); });
      return secs ? t / 60 : t;
    };
    const ex = (name) => g.find((r) => r[0] === name);
    // workout 20 has no recorded exercises, so its assumed rows add 75-sec carries/lunges/C&P; check those separately below.
    assert.strictEqual(ex('goblet squat')[3], String(kbSrc.filter((r) => r.exercises).reduce((t, r) => t + (Number((/(\d+) goblet squats/.exec(r.exercises) || [0, 0])[1]) * Number(r.rounds)), 0)));
    assert.strictEqual(ex('plank')[3], String(sum('plank', true)));
    assert.strictEqual(ex('plank')[2], '7');
    assert.deepStrictEqual([ex('plank')[4], ex('plank')[5]], ['60', '60']);
    assert.strictEqual(ex('KB swing')[3], String(sum('KB swings')));
    assert.strictEqual(ex('KB swing')[2], '6');
    assert.strictEqual(ex('push-up')[3], String(sum('push-ups')));
    assert.strictEqual(ex('plank')[1], 'sec');
    assert.deepStrictEqual([ex('KB swing')[4], ex('KB swing')[5]], ['20', '20']);
  });
  test(`[${mode}] progression grid shows best amount per week`, () => {
    const g = b.grid('Summary');
    const head = g.findIndex((r) => r[0] === 'Exercise' && r[1] === '1');
    const row = g.slice(head + 1).find((r) => r[0] === 'plank');
    assert.strictEqual(row[1], '45');   // week 1: 45-sec plank
    assert.strictEqual(row[3], '60');   // week 3 (12 Aug): 60-sec
    assert.strictEqual(row[8], '45');   // week 8 (14 Sep): comeback 45-sec
    assert.strictEqual(row[9], '60');   // week 9: restored
    assert.strictEqual(row[5], '60');   // week 5 (26 Aug)
    assert.deepStrictEqual([row[6], row[7]], ['', '']); // weeks 6 and 7: the break, nothing logged
  });
}

// =============================================================== backfill
{
  const b = createBackend({ csvFile: CSV, mode: 'text', now: '2026-10-07T08:00:00Z' });
  b.run('migrate');
  test('backfill: 5 Oct C session is logged on the right date, with no invented start time', () => {
    b.run('backfill');
    const row = b.grid('Log')[21];
    assert.deepStrictEqual([row[0], row[2], row[3], row[4], row[6], row[8], row[9]], ['21', 'C #7', '2026-10-05', '', 'Mon', 'Yes', 'C4']);
    assert.strictEqual(b.grid('Sets').slice(1).filter((s) => s[0] === '21').length, 4);
  });
  test('backfill: running it twice adds nothing; app says A is due; Missed now shows 3 (28 Sep, 30 Sep, 2 Oct)', () => {
    b.run('backfill');
    assert.strictEqual(b.grid('Log').length, 22);
    const r = b.post({ key: b.key, action: 'load' });
    assert.deepStrictEqual([r.total, r.due], [21, 'A']);
    const m = b.grid('Missed').slice(1).filter((x) => x[2] === 'Missed').map((x) => x[0]);
    assert.deepStrictEqual(m, ['2026-09-28', '2026-09-30', '2026-10-02']);
    assert.strictEqual(b.grid('Missed').slice(1).find((x) => x[0] === '2026-10-07')[2], ''); // today: not counted as missed yet
  });
}

// =============================================================== the web app
{
  const b = createBackend({ csvFile: CSV, mode: 'text' });
  b.run('migrate');
  const K = b.key;
  const call = (o) => b.post({ key: K, ...o });
  const logRows = () => b.grid('Log').slice(1);

  test('no key / wrong key is refused, and data is never returned', () => {
    assert.strictEqual(b.post({ action: 'load' }).error, 'bad_key');
    const r = b.post({ key: 'wrong-key-12345', action: 'load' });
    assert.deepStrictEqual(Object.keys(r).sort(), ['error', 'ok']);
    assert.strictEqual(b.post('not json').error, 'bad_request');
  });
  test('GET shows nothing private', () => { assert.ok(!JSON.stringify(JSON.parse(b.run('doGet').content)).includes('goblet')); });

  test('load, add, undo, note and sport never read a formula cell (keeps Google fast)', () => {
    b.setNow('2026-09-26T09:30:00Z');
    b.wb.formulaReads = 0;
    call({ action: 'load' });
    call({ action: 'add', session: 'C', id: 'perf-1' });
    call({ action: 'note', id: 'perf-1', note: 'x' });
    b.setNow('2026-09-26T09:31:00Z');
    call({ action: 'sport', activity: 'rugby', id: 'perf-sp' });
    assert.strictEqual(call({ action: 'undo', id: 'perf-sp' }).undone, true);
    assert.strictEqual(call({ action: 'undo', id: 'perf-1' }).undone, true);
    assert.strictEqual(b.wb.formulaReads, 0);
    assert.strictEqual(call({ action: 'load' }).total, 20);
  });

  test('load: plan, latest entries, due session, total', () => {
    const r = call({ action: 'load' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total, 20);
    assert.deepStrictEqual(r.order, ['C', 'A', 'B']);
    assert.strictEqual(r.due, 'C'); // last logged was B
    assert.strictEqual(r.last.label, 'B #7'); assert.strictEqual(r.last.n, 20);
    assert.deepStrictEqual(r.plan.A.exercises, ['12 goblet squat', '12 push-up', '12 single-arm KB row each arm (split-stance)', '12 Romanian deadlift', '60-sec plank']);
    assert.deepStrictEqual([r.plan.C.day, r.plan.C.rounds, r.plan.C.version], ['Mon', 4, 'C4']);
    assert.strictEqual(r.latest[0].kind, 'session'); assert.strictEqual(r.latest[0].n, 20);
    assert.strictEqual(r.undoId, ''); // migrated rows can't be undone
  });
  test('load: plan has structured items for the session guide, and server timing is reported', () => {
    const r = call({ action: 'load' });
    assert.deepStrictEqual(r.plan.B.items[0], { name: 'suitcase carry', amount: 75, unit: 'sec', per_side: 'side', variant: '' });
    assert.deepStrictEqual(r.plan.A.items[2], { name: 'single-arm KB row', amount: 12, unit: 'reps', per_side: 'arm', variant: 'split-stance' });
    assert.strictEqual(r.plan.C.items.length, 4);
    assert.ok(r.timing && typeof r.timing.lockMs === 'number' && typeof r.timing.workMs === 'number');
  });

  let c21;
  test('add: C session writes Log + Sets rows with everything captured automatically', () => {
    b.setNow('2026-09-28T07:45:20Z'); // Monday
    const r = call({ action: 'add', session: 'C', id: 'tap-0001' });
    assert.strictEqual(r.ok, true);
    c21 = r.entry;
    assert.deepStrictEqual([c21.n, c21.label, c21.date, c21.time, c21.version, c21.rounds, c21.onSchedule], [21, 'C #7', '2026-09-28', '07:45', 'C4', 4, 'Yes']);
    const row = logRows()[20];
    assert.deepStrictEqual([row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[13]], ['21', 'C', 'C #7', '2026-09-28', '07:45', '2026-09-28 07:45:20', 'Mon', '10', 'Yes', 'C4', '4', 'tap-0001']);
    const sets = b.grid('Sets').slice(1).filter((s) => s[0] === '21');
    assert.deepStrictEqual(sets.map((s) => [s[2], s[3], s[4], s[5], s[6], s[9], s[12]]), [
      ['KB swing', '20', 'reps', '', '4', '80', 'tap-0001'], ['clean & press', '5', 'reps', 'arm', '4', '40', 'tap-0001'],
      ['goblet squat', '12', 'reps', '', '4', '48', 'tap-0001'], ['mountain climber', '12', 'reps', 'leg', '4', '96', 'tap-0001']]);
    assert.strictEqual(b.grid('Plan history').slice(1).filter((r) => r[0] === 'C4').length, 4); // no new version: plan unchanged
  });
  test('add: the same tap sent twice (bad signal retry) is not logged twice', () => {
    const r = call({ action: 'add', session: 'C', id: 'tap-0001' });
    assert.strictEqual(r.duplicate, true);
    assert.strictEqual(logRows().length, 21); assert.strictEqual(b.grid('Sets').slice(1).length, 84);
  });
  test('add: due session moves on, and load reflects the new entry', () => {
    const r = call({ action: 'load' });
    assert.strictEqual(r.due, 'A'); assert.strictEqual(r.total, 21);
    assert.strictEqual(r.latest[0].label, 'C #7'); assert.strictEqual(r.undoId, 'tap-0001');
  });
  test('summary updates after an add', () => {
    const g = b.grid('Summary');
    assert.strictEqual(g.find((r) => r[0] === 'Kettlebell sessions')[1], '21');
    assert.strictEqual(g.find((r) => r[0] === 'Last session')[1], 'C #7');
    const m = b.grid('Missed').slice(1).find((r) => r[0] === '2026-09-28');
    assert.deepStrictEqual([m[1], m[2]], ['C', 'Done']);
  });

  test('note: added to a session, appended if one exists, and never run as a formula', () => {
    let r = call({ action: 'note', id: 'tap-0001', note: 'Felt strong' });
    assert.strictEqual(r.entry.notes, 'Felt strong');
    r = call({ action: 'note', id: 'tap-0001', note: '=1+1' });
    assert.strictEqual(r.entry.notes, 'Felt strong | =1+1');
    assert.strictEqual(logRows()[20][12], 'Felt strong | =1+1');
    assert.strictEqual(call({ action: 'note', id: 'nope', note: 'x' }).error, 'not_found');
    assert.strictEqual(call({ action: 'note', id: 'tap-0001', note: '' }).error, 'bad_request');
  });

  test('add: note sent with the tap is stored', () => {
    b.setNow('2026-09-30T18:05:00Z');
    const r = call({ action: 'add', session: 'a', id: 'tap-0002', note: 'Quick one' });
    assert.deepStrictEqual([r.entry.label, r.entry.notes, r.entry.time], ['A #8', 'Quick one', '18:05']);
  });

  test('undo: removes the last entry, its Sets rows, and frees the workout number', () => {
    const r = call({ action: 'undo', id: 'tap-0002' });
    assert.strictEqual(r.undone, true);
    assert.strictEqual(logRows().length, 21);
    assert.ok(!b.grid('Sets').slice(1).some((s) => s[12] === 'tap-0002'));
    assert.strictEqual(b.grid('Sets').slice(1).length, 84);
    assert.strictEqual(call({ action: 'load' }).total, 21);
  });
  test('undo: tapping Undo twice does nothing the second time', () => {
    const r = call({ action: 'undo', id: 'tap-0002' });
    assert.deepStrictEqual([r.ok, r.undone], [true, false]);
    assert.strictEqual(logRows().length, 21);
  });
  test('undo: will not remove an entry that is no longer the latest', () => {
    b.setNow('2026-10-02T17:00:00Z');
    call({ action: 'add', session: 'A', id: 'tap-0003' });
    const r = call({ action: 'undo', id: 'tap-0001' });
    assert.strictEqual(r.error, 'not_last');
    assert.strictEqual(logRows().length, 22);
    call({ action: 'undo', id: 'tap-0003' });
  });
  test('undo: with no id removes the latest app entry; migrated rows are never undone', () => {
    assert.strictEqual(call({ action: 'undo' }).undone, true);         // removes tap-0001
    assert.strictEqual(logRows().length, 20);
    assert.strictEqual(call({ action: 'undo' }).error, 'nothing_to_undo');
    assert.strictEqual(logRows().length, 20);
  });

  test('sport: logged to the Sport tab, not counted as a workout, undoable, with note', () => {
    b.setNow('2026-10-04T19:00:00Z');
    let r = call({ action: 'sport', activity: 'Rugby', id: 'sp-1', duration: 50 });
    assert.deepStrictEqual([r.entry.kind, r.entry.label, r.entry.date, r.entry.duration], ['sport', 'Rugby', '2026-10-04', 50]);
    assert.strictEqual(b.grid('Sport').slice(1).length, 5);
    assert.strictEqual(call({ action: 'load' }).total, 20);
    assert.strictEqual(call({ action: 'note', id: 'sp-1', note: 'Won' }).entry.notes, 'Won');
    assert.strictEqual(call({ action: 'sport', activity: 'rugby', id: 'sp-1' }).duplicate, true);
    assert.strictEqual(b.grid('Sport').slice(1).length, 5);
    assert.strictEqual(call({ action: 'undo', id: 'sp-1' }).undone, true);
    assert.strictEqual(b.grid('Sport').slice(1).length, 4);
    assert.strictEqual(call({ action: 'sport', activity: 'chess' }).error, 'bad_request');
    assert.strictEqual(call({ action: 'sport', activity: 'badminton', duration: 'lots' }).error, 'bad_request');
  });

  test('bad input is rejected without writing anything', () => {
    assert.strictEqual(call({ action: 'add', session: 'Z' }).error, 'bad_request');
    assert.strictEqual(call({ action: 'add', session: 'A', date: '2026-02-30' }).error, 'bad_request');
    assert.strictEqual(call({ action: 'add', session: 'A', time: '25:00' }).error, 'bad_request');
    assert.strictEqual(call({ action: 'nope' }).error, 'bad_action');
    assert.strictEqual(logRows().length, 20);
  });

  test('plan change: editing the Plan tab creates a new version, history keeps the old one, sessions trace to it', () => {
    const plan = b.tab('Plan');
    // A: push-ups 12 -> 15 (row 3 of the left table), as the owner would edit in the sheet
    const row = b.grid('Plan').findIndex((r) => r[0] === 'A' && r[2] === 'push-up') + 1;
    plan.getRange(row, 4).setValue(15);
    b.setNow('2026-10-05T07:00:00Z');
    const r = call({ action: 'add', session: 'A', id: 'tap-0010' });
    assert.strictEqual(r.entry.version, 'A6');
    const hist = b.grid('Plan history').slice(1);
    assert.strictEqual(hist.filter((h) => h[0] === 'A6').length, 5);
    assert.strictEqual(hist.find((h) => h[0] === 'A6')[2], '2026-10-05');
    assert.strictEqual(hist.find((h) => h[0] === 'A5' && h[6] === 'push-up')[7], '12'); // old version untouched
    assert.strictEqual(b.grid('Plan').slice(1, 4)[0][11], 'A6');
    assert.strictEqual(b.grid('Sets').slice(1).find((s) => s[0] === '21' && s[2] === 'push-up')[3], '15');
    const r2 = call({ action: 'add', session: 'A', id: 'tap-0011' });
    assert.strictEqual(r2.entry.version, 'A6'); // same plan again: no new version
    assert.strictEqual(b.grid('Plan history').slice(1).filter((h) => h[0] === 'A7').length, 0);
  });
  test('plan change: rounds and per-side edits also count, and a broken Plan gives a clear error', () => {
    const plan = b.tab('Plan');
    plan.getRange(2, 11).setValue(5); // A rounds in the right-hand table
    assert.strictEqual(call({ action: 'add', session: 'A', id: 'tap-0012' }).entry.version, 'A7');
    plan.getRange(2, 11).setValue('lots');
    const r = call({ action: 'add', session: 'A', id: 'tap-0013' });
    assert.strictEqual(r.error, 'bad_plan');
    plan.getRange(2, 11).setValue(4);
    assert.strictEqual(call({ action: 'load' }).ok, true);
  });
  test('a new exercise added to the plan appears on the Summary tab', () => {
    const plan = b.tab('Plan');
    const r = plan.getLastRow() + 1;
    // find the first empty row in the left table
    let row = 2; while (b.grid('Plan')[row - 1] && b.grid('Plan')[row - 1][0] !== '') row++;
    plan.getRange(row, 1, 1, 7).setValues([['B', 9, 'turkish get-up', 3, 'reps', 'arm', '']]);
    b.setNow('2026-10-07T07:00:00Z');
    call({ action: 'add', session: 'B', id: 'tap-0020' });
    const g = b.grid('Summary');
    const tgu = g.find((x) => x[0] === 'turkish get-up');
    assert.ok(tgu); assert.strictEqual(tgu[2], '1'); assert.strictEqual(tgu[3], '24'); // 3 reps x 2 arms x 4 rounds
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
