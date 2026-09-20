# Kid Points

A points board and allowance tracker for E, L and M. The kids can look at it
any time; only you can change it.

**Everyone starts each week with $10.** Each point earned adds 25¢ on top;
each point lost takes 25¢ off. A week can fall to $0 but never becomes a debt
the kid owes back — it takes 40 points in the hole to lose the whole allowance.

Weeks run Friday to Thursday and are paid the following Friday. A week you
haven't handed over yet shows as **still owed**, per kid, so a kid checking on
a Tuesday knows exactly where they stand.

---

## Setup, once

**1. Put the files on GitHub.**

```bash
git remote add origin https://github.com/vasanthsarathy/kid-points.git
git push -u origin main
```

The repo must be **public** — that is what lets the kids' phones read the
scores without logging in. The only thing in it is first initials, point
numbers, and your behavior lists.

**2. Turn on Pages.** In the repo: *Settings → Pages → Build and deployment →
Deploy from a branch → `main` / `(root)` → Save.* A minute later the site is at
`https://vasanthsarathy.github.io/kid-points/`. That's the link to give the
kids.

**3. Make a token.** This is what lets your phone write to the file.

- Go to *GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained tokens → Generate new token.*
- **Repository access:** Only select repositories → `kid-points`
- **Permissions:** Repository permissions → **Contents → Read and write**.
  Nothing else.
- Expiration: as long as GitHub lets you. Set a calendar reminder to make a new
  one when it lapses.
- Copy the token. GitHub shows it exactly once.

**4. Unlock the site.** Open your Pages URL, tap **Parent**, paste the token,
and pick a short password. Both stay in that browser. Do the same on any other
device you want to change points from. If you ever forget the password, the
unlock box offers to set the device up again.

**5. Make it yours.** Tap **Settings** to set the weekly allowance, the rate,
and the kids' names and emoji, then open **Earn & lose** to edit the two lists.

---

## The game

The dots on each card **are the money**. There is one per 25¢ of the weekly
allowance — 40 of them — and they all start lit, because the $10 is already
theirs. Lose points and dots go dark from the end. Earn points and gold ones
stack on past the guarantee.

There are four things to earn:

| | What it takes |
|---|---|
| 🌱 ⚡ 🚀 🏆 👑 | +10, +20, +30, +40 and +50 points in a week — Sprout, Spark, Rocket, Champion, Legend. Below 10 the badge counts down instead. |
| ✨ | The first point above the plain allowance |
| 👑 | Beating their own best week |
| 🔥 | Two or more weeks in a row finishing above the allowance |

Crossing one sets off confetti on the card. Because the celebration is worked
out from the score rather than from your tap, **each kid gets their own**
confetti the first time they open the page after crossing — you are not the
only one who sees it. Each browser keeps its own note of what it has already
shown, so nothing fires twice and nothing is missed.

Tiers reset every Friday with the points. Best and streak carry over. If a kid
loses points and drops back under a rung, the badge quietly steps down and
re-crossing it celebrates again. A streak ends silently — the flame just stops
appearing — rather than announcing that a run was broken.

---

## Using it

**Points.** Tap `+` or `−` on a kid's card. One point per tap, so ten taps is
+10. The number moves immediately and everything is written to GitHub in a
single commit about a second and a half after you stop tapping. The pill at the
bottom of the screen says `Saving…` and then `Saved`.

**Behaviors as shortcuts.** On the **Earn & lose** tab, tap a row like
*Made your bed +2*, pick a kid, and it applies the points in one go.

**Paying out.** Every Friday the week closes on its own. Each kid's card then
shows what they're owed with its own **Mark paid** button, so you can settle one
kid without the others. Below the cards, each week also has **Pay everyone** for
the usual case where all three get paid at once.

**Resetting one kid.** Each card has **Reset _name_'s week**, which puts that
kid back to 0 points — the plain allowance again — and leaves their best week,
their streak and anything they're owed alone.

**Resetting everything.** Settings has *Mark everything paid* and *Start over*,
which deletes every payout record and sets all three to zero. Your earn and lose
lists survive both.

---

## How the kids are locked out

Every write goes through GitHub, and GitHub only accepts a valid token. The
kids' devices have no token, so there is nothing for them to bypass — dev tools
included.

The password is a curtain on top of that, and only on a device that already has
a token. Its job is to stop a kid who picks up your unlocked phone. A
determined kid on *your* phone can get past it; that was a deliberate trade for
not needing a server.

If a token ever leaks, revoke it in GitHub settings and make a new one. The
worst it can do is edit this one repo.

---

## For anyone poking at the code

No build step, no dependencies, no framework. Five files that matter:

| File | What it is |
|---|---|
| `logic.js` | Pure functions: dates, weekly cycles, money, payouts. No DOM, no network. |
| `app.js` | Rendering, GitHub reads and writes, unlock, save batching. |
| `index.html` | The shell and the dialogs. |
| `styles.css` | Everything visual. |
| `data.json` | The whole state. |

```bash
node --test          # runs logic.test.js, no install needed
```

The weekly rollover is **derived, not scheduled**: `rollForward(state, today)`
closes every week that has finished since the file was last touched. No server
wakes up on Friday, and a month of nobody opening the page produces four correct
payouts rather than one wrong one.

Older files are brought forward by `migrate(state)` on read — it fills in the
weekly allowance and moves week-level payment records onto each kid, so
anything already marked paid stays paid.

Saves are sent with the file's current `sha`. If you edited from your laptop and
then your phone, the stale write is rejected, and the app refetches and replays
your taps onto the newer copy instead of overwriting it.

To run it locally, serve the folder over HTTP — opening `index.html` as a file
won't work, because ES modules and `crypto.subtle` both need a real origin.
