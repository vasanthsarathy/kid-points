import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays, daysBetween, weekdayOf, todayIn,
  fmtDay, fmtRange,
  centsFor, formatMoney,
  nextPayday, rollForward, prunePayouts,
  applyPending, pendingCount, outstanding,
} from './logic.js';

// 2026-09-18 is a Friday; 2026-09-20 is the Sunday after it.

function seed(overrides = {}) {
  return {
    version: 1,
    config: { centsPerPoint: 25, timezone: 'America/Los_Angeles' },
    cycle: { startDate: '2026-09-18' },
    kids: [
      { id: 'e', name: 'E', emoji: '🦊', points: 12 },
      { id: 'l', name: 'L', emoji: '🐼', points: 20 },
      { id: 'm', name: 'M', emoji: '🦖', points: -3 },
    ],
    payouts: [],
    behaviors: { positive: [], negative: [] },
    ...overrides,
  };
}

test('addDays crosses months and years', () => {
  assert.equal(addDays('2026-09-18', 7), '2026-09-25');
  assert.equal(addDays('2026-09-28', 6), '2026-10-04');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-09-18', -7), '2026-09-11');
});

test('addDays is unaffected by daylight saving transitions', () => {
  // US DST ends 2026-11-01. Naive local-midnight math loses or gains a day here.
  assert.equal(addDays('2026-10-30', 7), '2026-11-06');
  assert.equal(addDays('2026-03-06', 7), '2026-03-13');
});

test('daysBetween counts forward days', () => {
  assert.equal(daysBetween('2026-09-20', '2026-09-25'), 5);
  assert.equal(daysBetween('2026-09-25', '2026-09-25'), 0);
  assert.equal(daysBetween('2026-09-26', '2026-09-25'), -1);
});

test('weekdayOf identifies Friday as 5', () => {
  assert.equal(weekdayOf('2026-09-18'), 5);
  assert.equal(weekdayOf('2026-09-20'), 0);
});

test('todayIn resolves the date in the configured zone, not the device zone', () => {
  assert.equal(todayIn('UTC', new Date('2026-09-20T12:00:00Z')), '2026-09-20');
  // 02:00 UTC is still the previous evening on the US west coast.
  assert.equal(todayIn('America/Los_Angeles', new Date('2026-09-20T02:00:00Z')), '2026-09-19');
  assert.equal(todayIn('Asia/Tokyo', new Date('2026-09-20T22:00:00Z')), '2026-09-21');
});

test('fmtDay and fmtRange read the way a person would say them', () => {
  assert.equal(fmtDay('2026-09-18'), 'Sep 18');
  assert.equal(fmtRange('2026-09-11', '2026-09-17'), 'Sep 11–17');
  assert.equal(fmtRange('2026-09-28', '2026-10-04'), 'Sep 28 – Oct 4');
});

test('centsFor floors a negative balance at zero', () => {
  assert.equal(centsFor(28, 25), 700);
  assert.equal(centsFor(0, 25), 0);
  assert.equal(centsFor(-6, 25), 0);
});

test('formatMoney always shows cents', () => {
  assert.equal(formatMoney(750), '$7.50');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(700), '$7.00');
});

test('nextPayday is the Friday one week after the cycle started', () => {
  assert.equal(nextPayday(seed()), '2026-09-25');
});

test('rollForward does nothing before the next payday', () => {
  const { state, changed } = rollForward(seed(), '2026-09-24');
  assert.equal(changed, false);
  assert.equal(state.payouts.length, 0);
  assert.equal(state.kids[0].points, 12);
  assert.equal(state.cycle.startDate, '2026-09-18');
});

test('rollForward closes the week once payday arrives', () => {
  const { state, changed } = rollForward(seed(), '2026-09-25');
  assert.equal(changed, true);
  assert.equal(state.payouts.length, 1);

  const p = state.payouts[0];
  assert.equal(p.id, '2026-09-25');
  assert.equal(p.weekStart, '2026-09-18');
  assert.equal(p.weekEnd, '2026-09-24');
  assert.equal(p.paid, false);
  assert.equal(p.paidOn, null);
  assert.deepEqual(p.kids.e, { points: 12, cents: 300 });
  assert.deepEqual(p.kids.l, { points: 20, cents: 500 });
  // M finished the week at -3, so the payout is zero but the points are recorded.
  assert.deepEqual(p.kids.m, { points: -3, cents: 0 });

  assert.deepEqual(state.kids.map(k => k.points), [0, 0, 0]);
  assert.equal(state.cycle.startDate, '2026-09-25');
});

test('rollForward creates one payout per missed week', () => {
  // Three weeks go by without anyone opening the page.
  const { state } = rollForward(seed(), '2026-10-16');
  assert.deepEqual(state.payouts.map(p => p.id),
    ['2026-09-25', '2026-10-02', '2026-10-09', '2026-10-16']);
  // Only the first closed week carries the points that were on the board.
  assert.equal(state.payouts[0].kids.l.cents, 500);
  assert.equal(state.payouts[1].kids.l.cents, 0);
  assert.equal(state.cycle.startDate, '2026-10-16');
});

test('rollForward is idempotent for a given day', () => {
  const once = rollForward(seed(), '2026-09-25').state;
  const twice = rollForward(once, '2026-09-25');
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.state, once);
});

test('rollForward does not mutate the state it was given', () => {
  const before = seed();
  rollForward(before, '2026-10-16');
  assert.equal(before.payouts.length, 0);
  assert.equal(before.kids[0].points, 12);
  assert.equal(before.cycle.startDate, '2026-09-18');
});

function payout(id, paid) {
  return { id, weekStart: addDays(id, -7), weekEnd: addDays(id, -1), kids: {}, paid, paidOn: paid ? id : null };
}

test('prunePayouts keeps the twelve most recent', () => {
  const many = Array.from({ length: 20 }, (_, i) => payout(addDays('2026-01-02', i * 7), true));
  const kept = prunePayouts(many);
  assert.equal(kept.length, 12);
  assert.equal(kept[0].id, '2026-02-27');
  assert.equal(kept.at(-1).id, '2026-05-15');
});

test('prunePayouts never drops an unpaid payout, however old', () => {
  const many = Array.from({ length: 20 }, (_, i) => payout(addDays('2026-01-02', i * 7), i !== 0));
  const kept = prunePayouts(many);
  assert.equal(kept.length, 13);
  assert.equal(kept[0].id, '2026-01-02');
  assert.equal(kept[0].paid, false);
});

test('outstanding lists unpaid payouts oldest first', () => {
  const state = seed({ payouts: [payout('2026-09-18', true), payout('2026-09-25', false), payout('2026-09-11', false)] });
  assert.deepEqual(outstanding(state).map(p => p.id), ['2026-09-11', '2026-09-25']);
});

test('applyPending replays point deltas onto whatever state it is handed', () => {
  const fresh = seed();
  fresh.kids[0].points = 40; // another device already added points
  const out = applyPending(fresh, { deltas: { e: 3, m: -2 } });
  assert.equal(out.kids[0].points, 43);
  assert.equal(out.kids[2].points, -5);
  assert.equal(fresh.kids[0].points, 40, 'input is not mutated');
});

test('applyPending ignores deltas for a kid who no longer exists', () => {
  const out = applyPending(seed(), { deltas: { nobody: 5 } });
  assert.deepEqual(out.kids.map(k => k.points), [12, 20, -3]);
});

test('applyPending marks one payout paid', () => {
  const state = seed({ payouts: [payout('2026-09-18', false)] });
  const out = applyPending(state, { ops: [{ type: 'markPaid', payoutId: '2026-09-18', on: '2026-09-20' }] });
  assert.equal(out.payouts[0].paid, true);
  assert.equal(out.payouts[0].paidOn, '2026-09-20');
});

test('applyPending marks every outstanding payout paid at once', () => {
  const state = seed({ payouts: [payout('2026-09-11', false), payout('2026-09-18', false)] });
  const out = applyPending(state, { ops: [{ type: 'markAllPaid', on: '2026-09-20' }] });
  assert.deepEqual(out.payouts.map(p => p.paid), [true, true]);
});

test('applyPending zeroes the week without touching payouts', () => {
  const state = seed({ payouts: [payout('2026-09-18', false)] });
  const out = applyPending(state, { ops: [{ type: 'zeroWeek' }] });
  assert.deepEqual(out.kids.map(k => k.points), [0, 0, 0]);
  assert.equal(out.payouts.length, 1);
});

test('applyPending start over clears payouts and points but keeps behaviors', () => {
  const state = seed({
    payouts: [payout('2026-09-18', false)],
    behaviors: { positive: [{ id: 'b1', label: 'Made your bed', points: 2 }], negative: [] },
  });
  const out = applyPending(state, { ops: [{ type: 'startOver', startDate: '2026-09-18' }] });
  assert.deepEqual(out.payouts, []);
  assert.deepEqual(out.kids.map(k => k.points), [0, 0, 0]);
  assert.equal(out.cycle.startDate, '2026-09-18');
  assert.equal(out.behaviors.positive.length, 1);
});

test('applyPending applies replacements for settings, kids and behaviors', () => {
  const out = applyPending(seed(), {
    ops: [
      { type: 'setConfig', config: { centsPerPoint: 50, timezone: 'UTC' } },
      { type: 'setKids', kids: [{ id: 'e', name: 'Ella', emoji: '⭐', points: 99 }] },
      { type: 'setBehaviors', behaviors: { positive: [{ id: 'b1', label: 'Read a book', points: 3 }], negative: [] } },
    ],
  });
  assert.equal(out.config.centsPerPoint, 50);
  assert.equal(out.kids.length, 1);
  assert.equal(out.kids[0].name, 'Ella');
  assert.equal(out.behaviors.positive[0].label, 'Read a book');
});

test('setKids preserves the points already on the board', () => {
  // The settings form edits names and emoji; it must not rewind the score.
  const out = applyPending(seed(), {
    ops: [{ type: 'setKids', kids: [{ id: 'e', name: 'Ella', emoji: '⭐', points: 0 }] }],
  });
  assert.equal(out.kids[0].points, 12);
});

test('applyPending runs deltas before ops so a zeroWeek wins', () => {
  const out = applyPending(seed(), { deltas: { e: 5 }, ops: [{ type: 'zeroWeek' }] });
  assert.equal(out.kids[0].points, 0);
});

test('pendingCount reports whether anything is unsaved', () => {
  assert.equal(pendingCount({ deltas: {}, ops: [] }), 0);
  assert.equal(pendingCount({ deltas: { e: 0 }, ops: [] }), 0, 'a delta of zero is not a change');
  assert.equal(pendingCount({ deltas: { e: 3, l: -1 }, ops: [{ type: 'zeroWeek' }] }), 3);
});

test('a week where nobody earned anything settles itself', () => {
  const broke = seed();
  for (const kid of broke.kids) kid.points = 0;
  const { state } = rollForward(broke, '2026-09-25');
  assert.equal(state.payouts[0].paid, true);
  assert.equal(state.payouts[0].paidOn, '2026-09-25');
  assert.equal(outstanding(state).length, 0, 'nothing sits in the owed list');
});

test('a week is still owed if even one kid earned something', () => {
  const mostly = seed();
  mostly.kids[0].points = 0;
  mostly.kids[1].points = 0;
  mostly.kids[2].points = 4;
  const { state } = rollForward(mostly, '2026-09-25');
  assert.equal(state.payouts[0].paid, false);
  assert.equal(outstanding(state).length, 1);
});

test('a week where the only points were negative settles itself', () => {
  const rough = seed();
  for (const kid of rough.kids) kid.points = -2;
  const { state } = rollForward(rough, '2026-09-25');
  assert.equal(state.payouts[0].paid, true);
  assert.deepEqual(state.payouts[0].kids.e, { points: -2, cents: 0 });
});
