import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays, daysBetween, weekdayOf, todayIn,
  fmtDay, fmtRange,
  centsFor, formatMoney, baselineSlots,
  nextPayday, migrate, rollForward, prunePayouts,
  outstanding, settled, owedTo, owedCents, lastPaidTo, weekIsOpen,
  applyPending, pendingCount,
  TIERS, tierFor, tierLevel, nextTier, milestones,
} from './logic.js';

// 2026-09-18 is a Friday; 2026-09-20 is the Sunday after it.

function seed(overrides = {}) {
  return {
    version: 1,
    config: { centsPerPoint: 25, baselineCents: 1000, timezone: 'America/Los_Angeles' },
    cycle: { startDate: '2026-09-18' },
    kids: [
      { id: 'e', name: 'E', emoji: '🦊', points: 12, best: 0, streak: 0 },
      { id: 'l', name: 'L', emoji: '🐼', points: 20, best: 0, streak: 0 },
      { id: 'm', name: 'M', emoji: '🦖', points: -3, best: 0, streak: 0 },
    ],
    payouts: [],
    behaviors: { positive: [], negative: [] },
    ...overrides,
  };
}

const share = (points, paid = false, paidOn = null) =>
  ({ points, cents: Math.max(0, 1000 + points * 25), paid, paidOn });

const payout = (id, kids) => ({ id, weekStart: addDays(id, -7), weekEnd: addDays(id, -1), kids });

/* ---------------- dates ---------------- */

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

/* ---------------- money ---------------- */

test('a week starts at the guaranteed allowance and moves either way', () => {
  const config = { centsPerPoint: 25, baselineCents: 1000 };
  assert.equal(centsFor(0, config), 1000);
  assert.equal(centsFor(10, config), 1250);
  assert.equal(centsFor(-8, config), 800);
});

test('a bad enough week reaches zero but never becomes a debt', () => {
  const config = { centsPerPoint: 25, baselineCents: 1000 };
  assert.equal(centsFor(-40, config), 0);
  assert.equal(centsFor(-60, config), 0, 'no negative payouts, ever');
});

test('the baseline defaults to ten dollars when a file predates it', () => {
  assert.equal(centsFor(0, { centsPerPoint: 25 }), 1000);
});

test('baselineSlots is one dot per point the allowance is worth', () => {
  assert.equal(baselineSlots({ centsPerPoint: 25, baselineCents: 1000 }), 40);
  assert.equal(baselineSlots({ centsPerPoint: 50, baselineCents: 1000 }), 20);
  assert.equal(baselineSlots({ centsPerPoint: 25, baselineCents: 700 }), 28);
  assert.equal(baselineSlots({ centsPerPoint: 5000, baselineCents: 1000 }), 1, 'never zero');
});

test('formatMoney always shows cents', () => {
  assert.equal(formatMoney(1250), '$12.50');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(1000), '$10.00');
});

/* ---------------- the game ---------------- */

test('tiers start at ten and climb by ten', () => {
  assert.equal(tierLevel(0), 0);
  assert.equal(tierLevel(9), 0);
  assert.equal(tierLevel(10), 1);
  assert.equal(tierLevel(29), 2);
  assert.equal(tierLevel(50), 5);
  assert.equal(tierLevel(500), 5, 'tops out at the last tier');
  assert.equal(tierLevel(-4), 0, 'no tier while under water');
});

test('tierFor and nextTier name the rung above and below', () => {
  assert.equal(tierFor(0), null);
  assert.equal(tierFor(34).name, 'Rocket');
  assert.equal(nextTier(34).name, 'Champion');
  assert.equal(nextTier(0).at, 10);
  assert.equal(nextTier(50), null, 'nothing left to climb');
  assert.equal(TIERS.length, 5);
});

test('milestones describe what a kid has earned right now', () => {
  const state = seed();
  state.kids[0].points = 30;
  state.kids[0].best = 12;
  state.kids[0].streak = 3;
  assert.deepEqual(milestones(state, state.kids[0]), { tier: 3, bonus: 1, best: 1, streak: 3 });
});

test('sitting exactly on the baseline is not yet a bonus', () => {
  const state = seed();
  state.kids[0].points = 0;
  assert.deepEqual(milestones(state, state.kids[0]), { tier: 0, bonus: 0, best: 0, streak: 0 });
});

test('a kid under water has earned nothing', () => {
  const state = seed();
  assert.deepEqual(milestones(state, state.kids[2]), { tier: 0, bonus: 0, best: 0, streak: 0 });
});

/* ---------------- cycles ---------------- */

test('nextPayday is the Friday one week after the cycle started', () => {
  assert.equal(nextPayday(seed()), '2026-09-25');
});

test('rollForward does nothing before the next payday', () => {
  const { state, changed } = rollForward(seed(), '2026-09-24');
  assert.equal(changed, false);
  assert.equal(state.payouts.length, 0);
  assert.equal(state.kids[0].points, 12);
});

test('rollForward closes the week once payday arrives', () => {
  const { state, changed } = rollForward(seed(), '2026-09-25');
  assert.equal(changed, true);

  const p = state.payouts[0];
  assert.equal(p.id, '2026-09-25');
  assert.equal(p.weekStart, '2026-09-18');
  assert.equal(p.weekEnd, '2026-09-24');
  assert.deepEqual(p.kids.e, { points: 12, cents: 1300, paid: false, paidOn: null });
  assert.deepEqual(p.kids.l, { points: 20, cents: 1500, paid: false, paidOn: null });
  // Even a week in the red still owes the allowance, less the damage.
  assert.deepEqual(p.kids.m, { points: -3, cents: 925, paid: false, paidOn: null });

  assert.deepEqual(state.kids.map(k => k.points), [0, 0, 0]);
  assert.equal(state.cycle.startDate, '2026-09-25');
});

test('a kid who wiped out the whole allowance has nothing to collect', () => {
  const rough = seed();
  rough.kids[0].points = -44;
  const { state } = rollForward(rough, '2026-09-25');
  assert.equal(state.payouts[0].kids.e.cents, 0);
  assert.equal(state.payouts[0].kids.e.paid, true, 'settles itself; there is nothing to hand over');
  assert.equal(state.payouts[0].kids.l.paid, false);
});

test('rollForward creates one payout per missed week', () => {
  const { state } = rollForward(seed(), '2026-10-16');
  assert.deepEqual(state.payouts.map(p => p.id),
    ['2026-09-25', '2026-10-02', '2026-10-09', '2026-10-16']);
  assert.equal(state.payouts[0].kids.l.cents, 1500);
  assert.equal(state.payouts[1].kids.l.cents, 1000, 'a quiet week is still worth the allowance');
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
});

test('closing a week records a personal best', () => {
  assert.equal(rollForward(seed(), '2026-09-25').state.kids[1].best, 20);
});

test('a personal best only ever goes up', () => {
  const state = seed();
  state.kids[1].best = 40;
  assert.equal(rollForward(state, '2026-09-25').state.kids[1].best, 40);
});

test('finishing above the baseline extends the streak, finishing at or below ends it', () => {
  const state = seed();
  state.kids[1].points = 0;          // exactly the baseline
  state.kids.forEach(k => { k.streak = 3; });
  const { state: after } = rollForward(state, '2026-09-25');
  assert.equal(after.kids[0].streak, 4, 'E finished up 12');
  assert.equal(after.kids[1].streak, 0, 'level is not progress');
  assert.equal(after.kids[2].streak, 0, 'M finished down');
});

/* ---------------- migration ---------------- */

test('migrate fills in the baseline for a file that predates it', () => {
  const old = seed();
  delete old.config.baselineCents;
  old.config.weeklyGoalCents = 700;
  const next = migrate(old);
  assert.equal(next.config.baselineCents, 1000);
  assert.equal(next.config.weeklyGoalCents, undefined, 'the old goal is gone');
});

test('migrate moves a week-level payment onto each kid', () => {
  const old = seed({
    payouts: [{
      id: '2026-09-11', weekStart: '2026-09-04', weekEnd: '2026-09-10',
      kids: { e: { points: 8, cents: 200 }, l: { points: 2, cents: 50 }, m: { points: -1, cents: 0 } },
      paid: true, paidOn: '2026-09-12',
    }],
  });
  const p = migrate(old).payouts[0];
  assert.equal(p.kids.e.paid, true);
  assert.equal(p.kids.e.paidOn, '2026-09-12', 'the date it was handed over survives');
  assert.equal(p.kids.l.paid, true);
  assert.equal(p.paid, undefined, 'the week-level flag is gone');
});

test('migrate leaves an unpaid week unpaid, except where nothing was owed', () => {
  const old = seed({
    payouts: [{
      id: '2026-09-11', weekStart: '2026-09-04', weekEnd: '2026-09-10',
      kids: { e: { points: 8, cents: 200 }, m: { points: -9, cents: 0 } },
      paid: false, paidOn: null,
    }],
  });
  const p = migrate(old).payouts[0];
  assert.equal(p.kids.e.paid, false);
  assert.equal(p.kids.m.paid, true, 'a zero share needs no payment');
});

test('migrate does not disturb records already stored per kid', () => {
  const current = seed({ payouts: [payout('2026-09-11', { e: share(8, true, '2026-09-11'), l: share(2) })] });
  const p = migrate(current).payouts[0];
  assert.equal(p.kids.e.paidOn, '2026-09-11');
  assert.equal(p.kids.l.paid, false);
});

test('migrate backfills missing best and streak', () => {
  const old = seed();
  for (const kid of old.kids) { delete kid.best; delete kid.streak; }
  assert.deepEqual(migrate(old).kids.map(k => [k.best, k.streak]), [[0, 0], [0, 0], [0, 0]]);
});

test('migrate does not mutate the state it was given', () => {
  const old = seed();
  delete old.config.baselineCents;
  migrate(old);
  assert.equal(old.config.baselineCents, undefined);
});

/* ---------------- payouts, per kid ---------------- */

test('a week stays open while anyone is still owed', () => {
  assert.equal(weekIsOpen(payout('2026-09-11', { e: share(0, true, 'x'), l: share(0) })), true);
  assert.equal(weekIsOpen(payout('2026-09-11', { e: share(0, true, 'x'), l: share(0, true, 'x') })), false);
  assert.equal(weekIsOpen(payout('2026-09-11', { e: share(-40), l: share(-40) })), false, 'nothing owed, nothing open');
});

test('outstanding and settled split the ledger', () => {
  const state = seed({
    payouts: [
      payout('2026-09-04', { e: share(0, true, 'x'), l: share(0, true, 'x') }),
      payout('2026-09-11', { e: share(0), l: share(0, true, 'x') }),
    ],
  });
  assert.deepEqual(outstanding(state).map(p => p.id), ['2026-09-11']);
  assert.deepEqual(settled(state).map(p => p.id), ['2026-09-04']);
});

test('owedTo and owedCents answer for one kid at a time', () => {
  const state = seed({
    payouts: [
      payout('2026-09-04', { e: share(0), l: share(0, true, 'x') }),
      payout('2026-09-11', { e: share(8), l: share(4) }),
    ],
  });
  assert.deepEqual(owedTo(state, 'e').map(p => p.id), ['2026-09-04', '2026-09-11']);
  assert.deepEqual(owedTo(state, 'l').map(p => p.id), ['2026-09-11']);
  assert.equal(owedCents(state, 'e'), 1000 + 1200);
  assert.equal(owedCents(state, 'l'), 1100);
});

test('lastPaidTo finds the most recent week a kid actually collected', () => {
  const state = seed({
    payouts: [
      payout('2026-09-04', { e: share(0, true, '2026-09-04') }),
      payout('2026-09-11', { e: share(4, true, '2026-09-12') }),
      payout('2026-09-18', { e: share(0) }),
    ],
  });
  assert.equal(lastPaidTo(state, 'e').id, '2026-09-11');
  assert.equal(lastPaidTo(state, 'nobody'), null);
});

test('prunePayouts keeps the twelve most recent', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    payout(addDays('2026-01-02', i * 7), { e: share(0, true, 'x') }));
  const kept = prunePayouts(many);
  assert.equal(kept.length, 12);
  assert.equal(kept[0].id, '2026-02-27');
  assert.equal(kept.at(-1).id, '2026-05-15');
});

test('prunePayouts never drops a week someone is still owed, however old', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    payout(addDays('2026-01-02', i * 7), { e: share(0, i !== 0, i !== 0 ? 'x' : null) }));
  const kept = prunePayouts(many);
  assert.equal(kept.length, 13);
  assert.equal(kept[0].id, '2026-01-02');
});

/* ---------------- unsaved changes ---------------- */

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

test('markPaid settles one kid without touching their siblings', () => {
  const state = seed({ payouts: [payout('2026-09-11', { e: share(0), l: share(0), m: share(0) })] });
  const out = applyPending(state, { ops: [{ type: 'markPaid', payoutId: '2026-09-11', kidId: 'e', on: '2026-09-20' }] });
  assert.equal(out.payouts[0].kids.e.paid, true);
  assert.equal(out.payouts[0].kids.e.paidOn, '2026-09-20');
  assert.equal(out.payouts[0].kids.l.paid, false);
  assert.equal(weekIsOpen(out.payouts[0]), true, 'still open for the other two');
});

test('markWeekPaid settles all three for one week', () => {
  const state = seed({
    payouts: [payout('2026-09-11', { e: share(0), l: share(0) }), payout('2026-09-18', { e: share(0), l: share(0) })],
  });
  const out = applyPending(state, { ops: [{ type: 'markWeekPaid', payoutId: '2026-09-11', on: '2026-09-20' }] });
  assert.equal(weekIsOpen(out.payouts[0]), false);
  assert.equal(weekIsOpen(out.payouts[1]), true, 'only the week named');
});

test('markAllPaid settles everything owed', () => {
  const state = seed({
    payouts: [payout('2026-09-11', { e: share(0), l: share(0) }), payout('2026-09-18', { e: share(0) })],
  });
  const out = applyPending(state, { ops: [{ type: 'markAllPaid', on: '2026-09-20' }] });
  assert.equal(outstanding(out).length, 0);
});

test('marking paid does not rewrite a date already recorded', () => {
  const state = seed({ payouts: [payout('2026-09-11', { e: share(0, true, '2026-09-11') })] });
  const out = applyPending(state, { ops: [{ type: 'markAllPaid', on: '2026-09-20' }] });
  assert.equal(out.payouts[0].kids.e.paidOn, '2026-09-11');
});

test('zeroKid resets one kid and leaves the others alone', () => {
  const out = applyPending(seed(), { ops: [{ type: 'zeroKid', kidId: 'l' }] });
  assert.deepEqual(out.kids.map(k => k.points), [12, 0, -3]);
});

test('zeroKid runs after the deltas, so a pending tap does not survive it', () => {
  const out = applyPending(seed(), { deltas: { l: 5 }, ops: [{ type: 'zeroKid', kidId: 'l' }] });
  assert.equal(out.kids[1].points, 0);
});

test('startOver clears payouts and points but keeps behaviors', () => {
  const state = seed({
    payouts: [payout('2026-09-11', { e: share(0) })],
    behaviors: { positive: [{ id: 'b1', label: 'Made your bed', points: 2 }], negative: [] },
  });
  const out = applyPending(state, { ops: [{ type: 'startOver', startDate: '2026-09-18' }] });
  assert.deepEqual(out.payouts, []);
  assert.deepEqual(out.kids.map(k => k.points), [0, 0, 0]);
  assert.equal(out.behaviors.positive.length, 1);
});

test('applyPending applies replacements for settings, kids and behaviors', () => {
  const out = applyPending(seed(), {
    ops: [
      { type: 'setConfig', config: { centsPerPoint: 50, baselineCents: 1400 } },
      { type: 'setKids', kids: [{ id: 'e', name: 'Ella', emoji: '⭐', points: 99 }] },
      { type: 'setBehaviors', behaviors: { positive: [{ id: 'b1', label: 'Read a book', points: 3 }], negative: [] } },
    ],
  });
  assert.equal(out.config.centsPerPoint, 50);
  assert.equal(out.config.baselineCents, 1400);
  assert.equal(out.kids[0].name, 'Ella');
  assert.equal(out.behaviors.positive[0].label, 'Read a book');
});

test('setKids preserves the points already on the board', () => {
  const out = applyPending(seed(), {
    ops: [{ type: 'setKids', kids: [{ id: 'e', name: 'Ella', emoji: '⭐', points: 0 }] }],
  });
  assert.equal(out.kids[0].points, 12);
});

test('pendingCount reports whether anything is unsaved', () => {
  assert.equal(pendingCount({ deltas: {}, ops: [] }), 0);
  assert.equal(pendingCount({ deltas: { e: 0 }, ops: [] }), 0, 'a delta of zero is not a change');
  assert.equal(pendingCount({ deltas: { e: 3, l: -1 }, ops: [{ type: 'zeroKid', kidId: 'e' }] }), 3);
});
