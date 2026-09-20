// Pure functions behind Kid Points: dates, weekly cycles, money, payouts.
// Nothing here touches the DOM, the network, or the clock — `today` always
// arrives as a "YYYY-MM-DD" string, so every rule below can be tested.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;
const PAYOUTS_KEPT = 12;
const DEFAULT_BASELINE_CENTS = 1000;

// Dates are handled as UTC midnights so daylight saving never shifts a day.
const toUTC = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUTC = ms => new Date(ms).toISOString().slice(0, 10);

export function addDays(iso, n) {
  return fromUTC(toUTC(iso) + n * DAY_MS);
}

export function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / DAY_MS);
}

/** 0 = Sunday … 5 = Friday. */
export function weekdayOf(iso) {
  return new Date(toUTC(iso)).getUTCDay();
}

/**
 * Today's date in the family's chosen zone, so every device agrees on what day
 * it is regardless of where a phone thinks it is. 'en-CA' formats as YYYY-MM-DD.
 */
export function todayIn(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}

export function fmtDay(iso) {
  return `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
}

export function fmtRange(startIso, endIso) {
  if (startIso.slice(0, 7) === endIso.slice(0, 7)) {
    return `${fmtDay(startIso)}–${+endIso.slice(8, 10)}`;
  }
  return `${fmtDay(startIso)} – ${fmtDay(endIso)}`;
}

/* ---------------- money ---------------- */

export const baselineCents = config => config.baselineCents ?? DEFAULT_BASELINE_CENTS;

/**
 * Every week starts at the guaranteed allowance; points move it either way.
 * It can reach zero but never turns into a debt the kid owes back.
 */
export function centsFor(points, config) {
  return Math.max(0, baselineCents(config) + points * config.centsPerPoint);
}

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** How many dots make up the guaranteed allowance — one per point's worth. */
export function baselineSlots(config) {
  return Math.max(1, Math.round(baselineCents(config) / config.centsPerPoint));
}

/* ---------------- the game ---------------- */

/** Rungs to climb inside a single week. They reset with the points on Friday. */
export const TIERS = [
  { at: 10, name: 'Sprout', emoji: '🌱', color: '#3fa55f' },
  { at: 20, name: 'Spark', emoji: '⚡', color: '#d99414' },
  { at: 30, name: 'Rocket', emoji: '🚀', color: '#6e7bf2' },
  { at: 40, name: 'Champion', emoji: '🏆', color: '#d9683a' },
  { at: 50, name: 'Legend', emoji: '👑', color: '#a755d6' },
];

/** 0 through TIERS.length — how many rungs are cleared. */
export function tierLevel(points) {
  return TIERS.filter(tier => points >= tier.at).length;
}

export function tierFor(points) {
  return TIERS[tierLevel(points) - 1] || null;
}

export function nextTier(points) {
  return TIERS.find(tier => points < tier.at) || null;
}

/**
 * Everything a kid has earned as of right now, as plain numbers. Comparing
 * this against what a device last showed is what decides whether to celebrate,
 * so each kid gets their own confetti the first time they open the page —
 * not only the parent who tapped the button.
 */
export function milestones(state, kid) {
  return {
    tier: tierLevel(kid.points),
    bonus: kid.points > 0 ? 1 : 0,
    best: kid.points > 0 && kid.points > (kid.best || 0) ? 1 : 0,
    streak: kid.streak || 0,
  };
}

/* ---------------- cycles ---------------- */

export function nextPayday(state) {
  return addDays(state.cycle.startDate, 7);
}

/**
 * Bring a file written by an older version up to date. Payments used to be
 * recorded per week; they are now per kid, so each kid inherits whatever the
 * week already said and nothing already marked paid comes back.
 */
export function migrate(state) {
  const next = structuredClone(state);

  next.config.baselineCents = baselineCents(next.config);
  delete next.config.weeklyGoalCents;

  for (const kid of next.kids) {
    kid.best = kid.best || 0;
    kid.streak = kid.streak || 0;
  }

  for (const payout of next.payouts) {
    for (const share of Object.values(payout.kids)) {
      if (share.paid === undefined) {
        share.paid = payout.paid === true || share.cents === 0;
        share.paidOn = share.paid ? (payout.paidOn || payout.id) : null;
      }
    }
    delete payout.paid;
    delete payout.paidOn;
  }

  return next;
}

/**
 * Close every week that has finished since the file was last touched.
 *
 * This is derived rather than scheduled: no server wakes up on Friday, so any
 * browser loading the page recomputes the same answer from the stored state
 * plus today's date. A `while` rather than an `if` is what makes a month of
 * silence produce four separate payouts instead of one oversized one.
 */
export function rollForward(state, today) {
  const next = structuredClone(state);
  let changed = false;

  // Ten years of weeks — a corrupt future date can't spin this forever.
  for (let guard = 0; guard < 520 && today >= addDays(next.cycle.startDate, 7); guard++) {
    const weekStart = next.cycle.startDate;
    const payday = addDays(weekStart, 7);
    const kids = {};

    for (const kid of next.kids) {
      const cents = centsFor(kid.points, next.config);
      // A kid who dug far enough to owe nothing has nothing to collect either.
      kids[kid.id] = { points: kid.points, cents, paid: cents === 0, paidOn: cents === 0 ? payday : null };
      // Records outlive the payout list, which gets pruned.
      kid.best = Math.max(kid.best || 0, kid.points);
      kid.streak = kid.points > 0 ? (kid.streak || 0) + 1 : 0;
      kid.points = 0;
    }

    next.payouts.push({ id: payday, weekStart, weekEnd: addDays(weekStart, 6), kids });
    next.cycle.startDate = payday;
    changed = true;
  }

  if (changed) next.payouts = prunePayouts(next.payouts);
  return { state: next, changed };
}

/* ---------------- payouts ---------------- */

const owes = share => share.cents > 0 && !share.paid;

/** True while anyone still has money coming for this week. */
export const weekIsOpen = payout => Object.values(payout.kids).some(owes);

const byDate = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Keeps the file small, but a week someone is still owed is never forgotten. */
export function prunePayouts(payouts, keep = PAYOUTS_KEPT) {
  const sorted = [...payouts].sort(byDate);
  const recent = new Set(sorted.slice(-keep).map(p => p.id));
  return sorted.filter(p => weekIsOpen(p) || recent.has(p.id));
}

/** Weeks with money still owed to somebody, oldest first. */
export function outstanding(state) {
  return [...state.payouts].sort(byDate).filter(weekIsOpen);
}

/** Weeks where everyone has been settled, most recent first. */
export function settled(state) {
  return [...state.payouts].sort(byDate).reverse().filter(p => !weekIsOpen(p));
}

/** Weeks this one kid is still owed for, oldest first. */
export function owedTo(state, kidId) {
  return [...state.payouts].sort(byDate).filter(p => p.kids[kidId] && owes(p.kids[kidId]));
}

export function owedCents(state, kidId) {
  return owedTo(state, kidId).reduce((sum, p) => sum + p.kids[kidId].cents, 0);
}

/** The last week this kid actually got money for. */
export function lastPaidTo(state, kidId) {
  return [...state.payouts].sort(byDate).reverse()
    .find(p => p.kids[kidId]?.paid && p.kids[kidId].cents > 0) || null;
}

/* ---------------- unsaved changes ---------------- */

export function emptyPending() {
  return { ops: [] };
}

/**
 * Queue a point change. Point taps are ordered alongside everything else
 * rather than held separately: replaying them out of order let a pending
 * reset swallow every tap made after it.
 */
export function queueBump(pending, kidId, delta) {
  const last = pending.ops[pending.ops.length - 1];
  if (last && last.type === 'bump' && last.kidId === kidId) last.delta += delta;
  else pending.ops.push({ type: 'bump', kidId, delta });
  return pending;
}

export function pendingCount(pending) {
  return (pending.ops || []).filter(op => op.type !== 'bump' || op.delta !== 0).length;
}

/**
 * Replay unsaved changes onto a state, in the order they were made. Changes
 * are kept as a list of small actions rather than a snapshot of the whole
 * file, so when a save collides with an edit from another device we can
 * re-apply onto the fresh copy instead of overwriting what they did.
 */
export function applyPending(state, pending) {
  const next = structuredClone(state);
  for (const op of pending.ops || []) applyOp(next, op);
  return next;
}

function pay(share, on) {
  if (share && !share.paid) { share.paid = true; share.paidOn = on; }
}

function applyOp(state, op) {
  switch (op.type) {
    case 'bump': {
      const kid = state.kids.find(k => k.id === op.kidId);
      if (kid) kid.points += op.delta;
      break;
    }
    case 'markPaid': {
      const payout = state.payouts.find(p => p.id === op.payoutId);
      pay(payout?.kids[op.kidId], op.on);
      break;
    }
    case 'markWeekPaid': {
      const payout = state.payouts.find(p => p.id === op.payoutId);
      for (const share of Object.values(payout?.kids || {})) pay(share, op.on);
      break;
    }
    case 'markAllPaid':
      for (const payout of state.payouts) {
        for (const share of Object.values(payout.kids)) pay(share, op.on);
      }
      break;
    case 'zeroKid': {
      const kid = state.kids.find(k => k.id === op.kidId);
      if (kid) kid.points = 0;
      break;
    }
    case 'startOver':
      state.payouts = [];
      for (const kid of state.kids) kid.points = 0;
      state.cycle.startDate = op.startDate;
      break;
    case 'setConfig':
      state.config = { ...state.config, ...op.config };
      break;
    case 'setKids':
      // The settings form edits names and emoji; scores stay where they are.
      state.kids = op.kids.map(edited => {
        const existing = state.kids.find(k => k.id === edited.id);
        return { ...edited, points: existing ? existing.points : (edited.points || 0) };
      });
      break;
    case 'setBehaviors':
      state.behaviors = op.behaviors;
      break;
  }
}
