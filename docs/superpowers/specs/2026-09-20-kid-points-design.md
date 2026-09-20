# Kid Points — Design

**Date:** 2026-09-20
**Status:** Approved

## Purpose

A single web page where a parent tracks behavior points for three kids (E, L, M)
and pays a weekly allowance derived from those points. The kids can read their
scores and their siblings' scores at any time; only the parent can change
anything. Hosted free on GitHub Pages, no accounts, no server.

## Success criteria

A kid opening the site on a Tuesday can answer, without asking anyone:

- How many points do I have right now, and what is that worth in dollars?
- Was I paid for last week, or am I still owed?
- When is the next payday?
- How do my siblings' scores compare?
- What earns points, and what loses them?

A parent can, from a phone, add or remove points for any kid in a couple of
taps, mark a payout as paid, edit the behavior lists, and reset when needed.

## Non-goals

- User accounts, email, or per-kid logins.
- A change-by-change activity feed. Payout records are kept; individual point
  adjustments are not logged.
- Mobile apps, notifications, or reminders.
- Any build step, package manager dependency, or framework.

---

## Architecture

Static files served by GitHub Pages from a **public** repo. The entire
application state lives in `data.json` in that same repo.

```
index.html      shell, both views
styles.css      presentation
logic.js        pure functions: cycles, money, payouts  (unit tested)
app.js          DOM rendering + GitHub API                (manual testing)
data.json       application state
package.json    {"type":"module"} so node --test can import logic.js
logic.test.js   tests for logic.js
README.md       one-time setup and day-to-day usage
todo.md         implementation checklist and review notes
```

No npm dependencies. `package.json` exists only to mark the directory as ESM so
Node's built-in test runner can import `logic.js`; there is no `node_modules`
and nothing to install.

### Read and write paths

**Reads (everyone).** `GET https://api.github.com/repos/{owner}/{repo}/contents/data.json?ref={branch}`
returns base64 content plus the blob `sha`. Unauthenticated this is 60
requests/hour per IP, ample for a family. It reflects a commit within seconds,
unlike the Pages CDN which can serve a stale file for minutes after a push.

On HTTP 403 (rate limited) or any network failure, fall back to
`fetch('data.json?t=' + Date.now())` — same-origin, possibly a few minutes
stale, and with no `sha`, so the app enters read-only mode and says so.

**Writes (parent only).** `PUT /repos/{owner}/{repo}/contents/data.json` with
`{message, content, sha, branch}` and an `Authorization: Bearer <token>` header.

Base64 must be UTF-8 safe because names and emoji are stored in the file:

```js
const decode = b64 => new TextDecoder().decode(
  Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
const encode = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
```

**Conflict handling.** The app holds `base` (last known server state plus its
`sha`) and `pending` (unsaved changes). A save applies `pending` to `base` and
PUTs with the stored `sha`. If GitHub returns 409 or 422 the `sha` is stale
(the parent edited from another device): re-fetch `base`, re-apply `pending`
onto the fresh state, and PUT once more. A second failure surfaces an error and
leaves `pending` intact so nothing is silently lost.

Representing `pending` as a set of *changes* rather than a whole-file snapshot
is what makes the retry correct — replaying `{e: +3}` onto fresh state preserves
the other device's edits, whereas replaying a snapshot would erase them.

```js
pending = {
  deltas: { e: +3, l: -1 },          // point adjustments by kid id
  ops: [ {type: 'markPaid', payoutId: '2026-09-18'} ]   // discrete actions
}
```

**Save batching.** Point buttons mutate `pending` and re-render instantly. A
save fires 1500 ms after the last interaction, so a bulk +10 is ten taps and one
commit. A status pill shows `Saving… / Saved ✓ / Couldn't save`. `beforeunload`
warns if `pending` is non-empty.

### Repo coordinates

A clearly marked constant block at the top of `app.js`, filled in once during
setup:

```js
const REPO = { owner: 'YOUR-GITHUB-USERNAME', name: 'kid-points', branch: 'main' };
```

---

## Data model

`data.json`. All dates are `YYYY-MM-DD` strings. All money is integer cents.

```json
{
  "version": 1,
  "config": {
    "centsPerPoint": 25,
    "timezone": "America/Los_Angeles"
  },
  "cycle": { "startDate": "2026-09-18" },
  "kids": [
    { "id": "e", "name": "E", "emoji": "🦊", "points": 12 },
    { "id": "l", "name": "L", "emoji": "🐼", "points": 20 },
    { "id": "m", "name": "M", "emoji": "🦖", "points": -3 }
  ],
  "payouts": [
    {
      "id": "2026-09-18",
      "weekStart": "2026-09-11",
      "weekEnd": "2026-09-17",
      "kids": { "e": { "points": 30, "cents": 750 },
                "l": { "points": 24, "cents": 600 },
                "m": { "points": -2, "cents": 0 } },
      "paid": false,
      "paidOn": null
    }
  ],
  "behaviors": {
    "positive": [ { "id": "b1", "label": "Made your bed", "points": 2 } ],
    "negative": [ { "id": "b7", "label": "Hit a sibling", "points": -5 } ]
  }
}
```

Notes:

- `cycle.startDate` is always a Friday.
- Negative behaviors store negative `points`, so applying a behavior is always
  addition.
- A payout's `id` is the payday, which equals `weekEnd + 1 day`.
- `payouts` keeps the 12 most recent entries; older ones are pruned on write,
  but an unpaid payout is never pruned regardless of age.
- The parent's token and curtain password are **not** in this file. They live in
  the parent's browser `localStorage` only.

---

## The weekly cycle

A week runs **Friday through Thursday**. It is paid on the Friday that follows
it. Given the current date 2026-09-20 (a Sunday): the open week is
Fri 2026-09-18 → Thu 2026-09-24, payable Fri 2026-09-25; the week before it,
Fri 09-11 → Thu 09-17, closed on Fri 09-18 and is either paid or outstanding.

### Derived, not scheduled

Nothing runs on a timer and no server is awake on Friday. Every browser that
loads the page derives the correct state from `data.json` plus today's date.
This makes the display correct even if the parent hasn't opened the site in a
month, and it makes the logic a pure function that can be tested.

```
rollForward(state, today) -> state
  while today >= addDays(state.cycle.startDate, 7):
      weekStart = state.cycle.startDate
      weekEnd   = addDays(weekStart, 6)
      payday    = addDays(weekStart, 7)
      append payout { id: payday, weekStart, weekEnd,
                      kids: { id: { points, cents: max(0, points) * centsPerPoint } },
                      paid: false, paidOn: null }
      set every kid's points to 0
      state.cycle.startDate = payday
  prune payouts
```

The `while` loop, rather than an `if`, is what handles several missed weeks in
one visit — each missed week produces its own payout record at its own amount.

Kids' browsers run `rollForward` for display only and never write. The parent's
browser runs it too; if it produced changes and the parent is unlocked, those
changes are saved immediately so the record becomes durable.

### Time zone

All date arithmetic uses `config.timezone`, never the device's clock setting, so
a phone and an iPad agree on what day it is. "Today" is obtained as
`new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())`, which
yields `YYYY-MM-DD` directly. Date math is done on those strings via UTC
`Date.UTC` arithmetic, avoiding local-midnight and DST pitfalls entirely.

On first-time setup the timezone is seeded from the parent's browser
(`Intl.DateTimeFormat().resolvedOptions().timeZone`) and stored in `data.json`.

### Money

`cents = max(0, points) * config.centsPerPoint`

Points may go negative and are displayed as negative, making the consequence
visible. A negative balance pays $0 and does **not** carry into the next week —
each Friday every kid starts at zero. At the default 25¢/point, roughly 28
points in a week is about $7.

---

## Views

One page, two tabs, no routing library — a `hidden` toggle on two sections.

### Dashboard

- A banner: `Next payday: Friday, Sep 25 · in 5 days`.
- Three kid cards, side by side on a desktop, stacked on a phone. Each shows the
  emoji avatar, the kid's name, a large point number, and `= $3.00 this week`.
- Outstanding payouts appear as a badge on the card:
  `$7.50 owed for Sep 11–17 · not paid yet`, in a warm alert color. A paid one
  shows quietly: `✓ $7.50 paid Sep 18`.
- Cards are not ranked or sorted by score; order is fixed, so a kid having a bad
  week isn't publicly placed last.

### How to earn points

Two lists, positive and negative, each entry showing a label and its point
value. Read-only to a kid. This is the page the parent edits.

### Parent controls (shown only when unlocked)

- `+` and `−` buttons on each kid card, ±1 per tap, instant and batched.
- On the behaviors tab, each entry becomes a tappable shortcut: tap
  `Made your bed +2`, choose a kid, and it applies +2 in one action.
- `Mark paid` on each outstanding payout.
- Add, edit, and delete behaviors in either list.
- Settings: cents per point, timezone, and each kid's name and emoji.
- Resets, each behind a confirmation:
  - **Zero out this week** — all three kids to 0 points, payouts untouched.
  - **Mark everything paid** — every outstanding payout marked paid today.
  - **Start over** — wipe all payouts, zero all points, restart the cycle at the
    current week. Keeps behaviors and settings. Guarded by type-to-confirm.

### Look and feel

Cute and playful, aimed at kids: rounded cards, soft pastel per-kid colors, a
friendly rounded typeface, oversized point numerals, chunky tap targets. Must
work at 400 px wide. Respects the viewer's light/dark preference. No external
CSS or JS dependencies; any font is a system stack.

---

## Parent unlock

The GitHub token is the only credential GitHub honors, so it is the real lock.
The password on top of it is a curtain, chosen deliberately with its limits
understood.

- **First time on a device:** tap `Parent`, paste the fine-grained token, choose
  a short password. Both are stored in `localStorage`; the password is stored as
  a SHA-256 hash, the token in plain text.
- **After that on that device:** tap `Parent`, type the password, controls
  appear for the session.
- **Kids' devices:** nothing is stored, so there is no token. GitHub rejects any
  write attempt regardless of what the kid does in dev tools. The curtain's only
  job is stopping a kid who picks up the parent's already-configured phone; it
  does not survive dev tools on that phone, and that is accepted.
- **`Forget this device`** clears both values from `localStorage`.

The token is a GitHub fine-grained personal access token scoped to this one
repository with `Contents: Read and write` and nothing else. If it leaks, the
worst case is someone editing this repo's files; revoking it in GitHub settings
is immediate.

---

## Error handling

| Situation | Behavior |
|---|---|
| Read rate-limited or offline | Fall back to `fetch('data.json')`; banner: "Showing saved scores, might be a few minutes old." No write controls. |
| `data.json` missing or malformed | Show a clear setup message pointing at the README rather than a blank page. |
| Write rejected, stale `sha` | Re-fetch, re-apply `pending`, retry once. |
| Write fails twice | Keep `pending`, show `Couldn't save — tap to retry`. Never discard the parent's taps. |
| Token invalid or revoked (401/403 on write) | Clear the token, drop to locked state, prompt to paste a new one. |
| Unsaved changes at page close | `beforeunload` warning. |

---

## Testing

`logic.js` is pure — no DOM, no network, no `Date.now()` except through an
injected `today` argument. Everything that is genuinely easy to get wrong lives
there and is covered by `node --test` with no dependencies:

- `addDays`, `todayIn(tz)`, `nextPayday`, `formatRange`
- `rollForward`: no close due; exactly one close; three missed weeks producing
  three separate payouts; a kid with negative points paying `0`; idempotence
  when called twice with the same `today`
- `centsFor` including the negative floor, and `formatMoney`
- payout pruning keeping 12 and never pruning an unpaid payout
- `applyPending` — deltas and ops replayed onto a fresh state

`app.js` is thin glue over `logic.js` and is verified by hand in the browser:
locked view, unlocked view, a batched bulk adjustment, a simulated conflict, and
a 400 px-wide layout check.

---

## One-time setup (documented in README)

1. Create a public GitHub repo named `kid-points` and push these files.
2. Settings → Pages → deploy from `main` branch, root.
3. Fill in `REPO` at the top of `app.js`.
4. Create a fine-grained PAT: repository access limited to `kid-points`,
   permission `Contents: Read and write`, a long expiry.
5. Open the Pages URL, tap `Parent`, paste the token, choose a password.
6. Set the kids' names, emoji, and the point rate; fill in the behavior lists.
