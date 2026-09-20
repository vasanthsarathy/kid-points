# Kid Points — implementation checklist

Design spec: `docs/superpowers/specs/2026-09-20-kid-points-design.md`

## Todo

- [x] `package.json` — ESM marker so `node --test` can import `logic.js`
- [x] `logic.test.js` — tests first: dates, rollForward, money, pruning, pending
- [x] `logic.js` — pure cycle/money/payout functions
- [x] `data.json` — starting state with the three kids and a behavior list
- [x] `index.html` — shell, dashboard view, behaviors view
- [x] `styles.css` — pips, kid panels, week ribbon, dark mode, 400px
- [x] `app.js` — rendering, GitHub read/write, parent unlock, batching
- [x] `README.md` — one-time setup and day-to-day use
- [x] `.gitattributes` — keep line endings sane on Windows
- [x] Run `node --test` and confirm green — 30 passing
- [x] Review section below

## Round two — gamification

- [x] `logic.js` — tiers, goal points, best and streak maintained on rollover
- [x] `logic.test.js` — 10 more tests for the above
- [x] `app.js` — tier badge, goal slots, trophies, milestone detection, confetti
- [x] `styles.css` — tier badges, slot states, cheer card, burst keyframes
- [x] `data.json` — `weeklyGoalCents`, plus `best` and `streak` per kid
- [x] `README.md` — a section explaining the game
- [x] Tests green — 40 unit, 46 headless assertions
- [x] Second headless run covering the Settings resets — 22 assertions

### Round two review

The pips became the game board rather than gaining a sibling: one slot per
point needed for $7, filling as they are earned, overflow in gold. That
replaced the progress bar the design first called for — one element now carries
the exact count and the distance to the money.

Four things to earn: weekly tiers at 10/20/30/40/50, the $7 goal, a personal
best, and a streak of goal weeks. Tiers and the goal are derived from the
score, so they need no storage. Best and streak are kept on the kid record and
updated when a week closes — deliberately not derived from `payouts`, which is
pruned to twelve weeks and would silently forget an old record.

The celebration is driven by comparing the current milestones against a note in
each browser's `localStorage`. That is what makes a kid see their own confetti
when they open the page on Tuesday, rather than the parent being the only one
who ever sees it. When a score drops the note rewinds, so re-crossing a rung
celebrates again and nothing double-fires.

Two bugs the headless run caught: an unqualified `matchMedia` call that threw
and killed every burst, and — in the test harness, not the app — a GitHub stub
that served the original state forever, which quietly rewound the app during a
conflict retry and made the assertions lie.

A second headless run drives the Settings dialog end to end: zero out the week,
mark everything paid, save settings, start over behind its type-to-confirm, and
forget the device. Those paths go through nested dialogs and were untested
until asked about directly; they all pass.

Still unverified: how any of it looks. No browser was available.

## Review

### What was built

A static page served from GitHub Pages. `data.json` in the same repo holds the
whole state; the kids' browsers read it and never write. A GitHub token, stored
only in the parent's browser, is what makes writes possible, so the lock is
enforced by GitHub rather than by the page.

Eight files, no build step, no dependencies. `logic.js` holds every rule worth
getting wrong and is pure; `app.js` is glue over it.

### Decisions made while building

- **Weekly rollover is derived, not scheduled.** `rollForward(state, today)`
  closes every week that has finished since the file was last touched. Nothing
  runs on Friday, so a month of nobody opening the page still produces four
  correct payouts. Kids' browsers compute it for display and never write it.
- **A week where nobody earned anything settles itself** rather than sitting in
  "not paid yet" forever, which also keeps old records prunable. All-zero weeks
  are hidden from the paid ledger too — they were pure noise.
- **Ten taps make one commit.** Taps land in a local `pending` object and a
  single commit fires 1.5s after the last one.
- **Unsaved changes are kept as deltas, not a snapshot.** When a save collides
  with an edit from another device, the app refetches and replays `{l: +10}`
  onto the newer copy instead of overwriting what the other device did.
- **Tapping patches one card instead of re-rendering the board.** Rebuilding the
  grid replaced the button under the parent's finger, which dropped rapid taps.
  Caught by the headless run, not by reading the code.
- **Points shown as tally pips** under the numeral, grouped in fives, so a kid
  who isn't confident reading two-digit or negative numbers can just count.

### Verification

- `node --test` — 30 passing, covering date math across months, years and DST,
  single and multi-week rollovers, idempotence, the negative-payout floor,
  payout pruning that never drops a debt, and delta replay.
- A headless run of the real `index.html` + `app.js` under jsdom (installed in a
  scratch directory, not added to this repo) with GitHub stubbed: 27 assertions
  over the locked view, three missed weeks, unlocking, ten batched taps landing
  as one commit, going negative, marking a week paid, and a 409 conflict being
  retried without losing the tap. No script errors.

### Not verified

The visual layout. The Chrome extension wasn't connected, and jsdom does no
layout, so nothing here confirms how the page actually *looks* — dark mode, the
400px stacking, and the pip wrapping are unreviewed. Worth a look on a phone
before showing the kids.

### Left deliberately undone

- No per-change history. Points move, but nothing records why.
- Payouts are marked paid a week at a time, for all three kids together, not per
  kid.
