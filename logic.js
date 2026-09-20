// Pure functions behind Kid Points: dates, weekly cycles, money, payouts.
// Nothing here touches the DOM, the network, or the clock — `today` always
// arrives as a "YYYY-MM-DD" string, so every rule below can be tested.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;
const PAYOUTS_KEPT = 12;

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

/** A week in the hole is worth nothing, never a debt. */
export function centsFor(points, centsPerPoint) {
  return Math.max(0, points) * centsPerPoint;
}

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function nextPayday(state) {
  return addDays(state.cycle.startDate, 7);
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
    const kids = {};
    for (const kid of next.kids) {
      kids[kid.id] = { points: kid.points, cents: centsFor(kid.points, next.config.centsPerPoint) };
      kid.points = 0;
    }
    // A week where nobody earned anything is not a debt, so it settles itself
    // rather than sitting in the "not paid yet" list forever.
    const payday = addDays(weekStart, 7);
    const owed = Object.values(kids).some(k => k.cents > 0);
    next.payouts.push({
      id: payday,
      weekStart,
      weekEnd: addDays(weekStart, 6),
      kids,
      paid: !owed,
      paidOn: owed ? null : payday,
    });
    next.cycle.startDate = addDays(weekStart, 7);
    changed = true;
  }

  if (changed) next.payouts = prunePayouts(next.payouts);
  return { state: next, changed };
}

/** Keeps the file small, but an unpaid week is a debt and is never forgotten. */
export function prunePayouts(payouts, keep = PAYOUTS_KEPT) {
  const sorted = [...payouts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const recent = new Set(sorted.slice(-keep).map(p => p.id));
  return sorted.filter(p => !p.paid || recent.has(p.id));
}

export function outstanding(state) {
  return prunePayouts(state.payouts, Infinity).filter(p => !p.paid);
}

export function paidHistory(state) {
  return prunePayouts(state.payouts, Infinity).filter(p => p.paid).reverse();
}

export function emptyPending() {
  return { deltas: {}, ops: [] };
}

export function pendingCount(pending) {
  const deltas = Object.values(pending.deltas || {}).filter(n => n !== 0).length;
  return deltas + (pending.ops || []).length;
}

/**
 * Replay unsaved changes onto a state. Changes are kept as deltas and discrete
 * ops rather than a snapshot of the whole file, so when a save collides with an
 * edit made on another device we can re-apply onto the fresh copy instead of
 * overwriting what the other device did.
 */
export function applyPending(state, pending) {
  const next = structuredClone(state);

  for (const [kidId, delta] of Object.entries(pending.deltas || {})) {
    const kid = next.kids.find(k => k.id === kidId);
    if (kid) kid.points += delta;
  }
  for (const op of pending.ops || []) applyOp(next, op);

  return next;
}

function applyOp(state, op) {
  switch (op.type) {
    case 'markPaid': {
      const payout = state.payouts.find(p => p.id === op.payoutId);
      if (payout) { payout.paid = true; payout.paidOn = op.on; }
      break;
    }
    case 'markAllPaid':
      for (const payout of state.payouts) {
        if (!payout.paid) { payout.paid = true; payout.paidOn = op.on; }
      }
      break;
    case 'zeroWeek':
      for (const kid of state.kids) kid.points = 0;
      break;
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
