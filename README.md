# Kid Points

A points board and allowance tracker for E, L and M. The kids can look at it
any time; only you can change it.

- Points reset every **Friday**. Whatever a kid finished the week with is what
  they get paid that Friday.
- At 25¢ a point, about 28 points in a week is about $7.
- A week you haven't paid yet shows up as **still owed**, so a kid checking on a
  Tuesday knows exactly where they stand.
- Points can go negative, but a payout never goes below $0 and a bad week never
  carries into the next one.

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
device you want to change points from.

**5. Make it yours.** Tap **Settings** to set names, emoji and the rate, then
open **Earn & lose** to edit the two lists.

---

## Using it

**Points.** Tap `+` or `−` on a kid's card. One point per tap, so ten taps is
+10. The number moves immediately and everything is written to GitHub in a
single commit about a second and a half after you stop tapping. The pill at the
bottom of the screen says `Saving…` and then `Saved`.

**Behaviors as shortcuts.** On the **Earn & lose** tab, tap a row like
*Made your bed +2*, pick a kid, and it applies the points in one go.

**Paying out.** Every Friday the week closes on its own and shows under
**Not paid yet** with what each kid is owed. When you hand over the money, tap
**Mark paid**. A week where nobody earned anything settles itself and never
appears there.

**Resets.** In Settings: *Zero out this week*, *Mark everything paid*, or
*Start over*, which deletes every payout record and sets all three to zero. Your
earn and lose lists survive all three.

**If you forget the password,** clear this site's data in your browser, or open
it in a private window. That wipes the saved token too, so paste it again.

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

Saves are sent with the file's current `sha`. If you edited from your laptop and
then your phone, the stale write is rejected, and the app refetches and replays
your taps onto the newer copy instead of overwriting it.

To run it locally, serve the folder over HTTP — opening `index.html` as a file
won't work, because ES modules and `crypto.subtle` both need a real origin.
