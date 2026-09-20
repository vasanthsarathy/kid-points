import {
  addDays, daysBetween, weekdayOf, todayIn, fmtDay, fmtRange,
  centsFor, formatMoney, baselineCents, baselineSlots,
  nextPayday, migrate, rollForward,
  outstanding, settled, owedTo, lastPaidTo,
  applyPending, emptyPending, pendingCount,
  TIERS, tierFor, nextTier, milestones,
} from './logic.js';

/* ------------------------------------------------------------------ *
 * Your repo. Change these if you rename it or use a different account.
 * Nothing else in this file needs editing.
 * ------------------------------------------------------------------ */
const REPO = { owner: 'vasanthsarathy', name: 'kid-points', branch: 'main' };

const FILE = 'data.json';
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${FILE}`;
const KID_COLORS = ['#6e7bf2', '#2bb3a3', '#f4718b', '#f0a500', '#9b6ef3'];
const SAVE_DELAY = 1500;
const MAX_PIPS = 50;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let base = null;                 // { state, sha } — last known server copy
let pending = emptyPending();    // taps not yet committed
let unlocked = false;
let readOnly = false;            // true when we could not reach the API
let today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
let saveTimer = null;
let saving = false;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- credentials (this device only) ---------------- */

const readToken = () => localStorage.getItem('kp.token') || '';
const readPwHash = () => localStorage.getItem('kp.pw') || '';

function forgetDevice() {
  localStorage.removeItem('kp.token');
  localStorage.removeItem('kp.pw');
  unlocked = false;
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- GitHub ---------------- */

const decodeB64 = b64 =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

const encodeB64 = text =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function headers() {
  const h = { Accept: 'application/vnd.github+json' };
  const token = readToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function fetchFromApi() {
  const res = await fetch(`${API}?ref=${REPO.branch}&t=${Date.now()}`, { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error(`read ${res.status}`), { status: res.status });
  const body = await res.json();
  return { state: JSON.parse(decodeB64(body.content)), sha: body.sha };
}

/** Same-origin copy. Can be a few minutes behind, and gives no sha, so no writing. */
async function fetchFromFile() {
  const res = await fetch(`${FILE}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`file ${res.status}`);
  return { state: await res.json(), sha: null };
}

async function putState(state, message) {
  const res = await fetch(API, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      branch: REPO.branch,
      sha: base.sha,
      content: encodeB64(JSON.stringify(state, null, 2) + '\n'),
    }),
  });

  if (res.status === 409 || res.status === 422) {
    throw Object.assign(new Error('conflict'), { conflict: true });
  }
  if (res.status === 401 || res.status === 403) {
    forgetDevice();
    throw Object.assign(new Error('auth'), { auth: true });
  }
  if (!res.ok) throw new Error(`write ${res.status}`);

  const body = await res.json();
  base = { state, sha: body.content.sha };
}

/* ---------------- loading ---------------- */

/** Bring an older file up to date, then close any weeks that have finished. */
function normalize(loaded) {
  today = todayIn(loaded.state.config.timezone || 'UTC');
  const current = migrate(loaded.state);
  const { state, changed } = rollForward(current, today);
  const moved = changed || JSON.stringify(current) !== JSON.stringify(loaded.state);
  return { loaded: { state, sha: loaded.sha }, changed: moved };
}

async function load() {
  let result;
  try {
    result = normalize(await fetchFromApi());
    readOnly = false;
  } catch (apiError) {
    try {
      result = normalize(await fetchFromFile());
      readOnly = true;
      note(apiError.status === 403
        ? 'Showing saved scores. GitHub is rate limiting right now, so this might be a few minutes behind.'
        : 'Showing saved scores. Could not reach GitHub, so this might be a few minutes behind.');
    } catch {
      document.querySelector('main').innerHTML =
        '<p class="lede">Could not load <b>data.json</b>. Check the <code>REPO</code> settings at the top of app.js, and that the repo is public. The README has the setup steps.</p>';
      return;
    }
  }

  base = result.loaded;
  render();

  // A closed week is only real once it is written down.
  if (result.changed && readToken() && !readOnly) queueSave(0);
}

/* ---------------- saving ---------------- */

const OP_LABEL = {
  markPaid: 'marked one kid paid',
  markWeekPaid: 'paid everyone for a week',
  markAllPaid: 'marked everything paid',
  zeroKid: 'reset a kid for the week',
  startOver: 'started over',
  setConfig: 'updated settings',
  setKids: 'updated the kids',
  setBehaviors: 'updated the lists',
};

function commitMessage(changes) {
  const parts = [];
  for (const [kidId, delta] of Object.entries(changes.deltas)) {
    if (!delta) continue;
    const kid = base.state.kids.find(k => k.id === kidId);
    parts.push(`${kid ? kid.name : kidId} ${delta > 0 ? '+' : ''}${delta}`);
  }
  for (const op of changes.ops) parts.push(OP_LABEL[op.type] || op.type);
  return parts.length ? parts.join(', ') : 'Close out the week';
}

function queueSave(delay = SAVE_DELAY) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, delay);
}

async function save() {
  if (saving || readOnly || !readToken()) return;
  saving = true;

  const changes = pending;
  pending = emptyPending();
  pill('Saving…');

  try {
    await putState(applyPending(base.state, changes), commitMessage(changes));
    pill('Saved', 1600);
  } catch (error) {
    if (error.conflict) {
      // Someone saved from another device. Rebuild on their copy, keep our taps.
      try {
        base = normalize(await fetchFromApi()).loaded;
        await putState(applyPending(base.state, changes), commitMessage(changes));
        pill('Saved', 1600);
      } catch {
        restore(changes);
      }
    } else if (error.auth) {
      restore(changes, 'That token stopped working. Tap Parent to paste a new one.');
    } else {
      restore(changes);
    }
  } finally {
    saving = false;
    render();
  }
}

function restore(changes, message) {
  for (const [kidId, delta] of Object.entries(changes.deltas)) {
    pending.deltas[kidId] = (pending.deltas[kidId] || 0) + delta;
  }
  pending.ops = [...changes.ops, ...pending.ops];
  pill(message || 'Could not save', 0, true);
}

function pill(text, hideAfter = 0, bad = false) {
  const node = $('savepill');
  node.className = 'savepill' + (bad ? ' bad' : '');
  node.textContent = text;
  node.hidden = false;
  if (bad) {
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.onclick = () => save();
    node.append(retry);
  }
  clearTimeout(pill.timer);
  if (hideAfter) pill.timer = setTimeout(() => { node.hidden = true; }, hideAfter);
}

function note(text) {
  const node = $('banner');
  node.textContent = text;
  node.hidden = !text;
}

/* ---------------- rendering ---------------- */

const view = () => applyPending(base.state, pending);
const colorOf = index => KID_COLORS[index % KID_COLORS.length];

function render() {
  const state = view();
  renderPayday(state);
  renderKids(state);
  renderWeeks(state);
  renderLists(state);
  $('base').textContent = formatMoney(baselineCents(state.config));
  $('rate').textContent = `${state.config.centsPerPoint}¢`;
  $('parent-btn').textContent = unlocked ? 'Settings' : 'Parent';
  checkMilestones(state);
}

function renderPayday(state) {
  const start = state.cycle.startDate;
  const payday = nextPayday(state);
  const away = daysBetween(today, payday);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const letter = 'SMTWTFS'[weekdayOf(date)];
    const kind = date === today ? 'today' : date < today ? 'done' : '';
    days.push(`<span class="${kind}" title="${fmtDay(date)}">${letter}</span>`);
  }
  days.push(`<span class="pay" title="Payday, ${fmtDay(payday)}">$</span>`);

  const when = away === 0 ? 'Payday is today' : away === 1 ? 'Payday is tomorrow' : `${away} days to go`;

  $('payday').innerHTML = `
    <div class="week">${days.join('')}</div>
    <div>
      <div class="payday-text">Next payday <b>${WEEKDAY[weekdayOf(payday)]}, ${fmtDay(payday)}</b></div>
      <div class="payday-sub">${when} — this week runs ${fmtRange(start, addDays(start, 6))}</div>
    </div>`;
}

/**
 * One line per week this kid is still owed for, each with its own button, so
 * one kid can be settled while their siblings are not.
 */
function kidStatus(state, kid) {
  const weeks = owedTo(state, kid.id);
  if (weeks.length) {
    return weeks.map(p => `
      <p class="status is-owed">
        <span>Still owed <span class="money">${formatMoney(p.kids[kid.id].cents)}</span> for ${fmtRange(p.weekStart, p.weekEnd)}</span>
        ${unlocked ? `<button class="paybtn" data-paid="${esc(p.id)}" data-kid="${esc(kid.id)}">Mark paid</button>` : ''}
      </p>`).join('');
  }

  const last = lastPaidTo(state, kid.id);
  if (last) {
    const share = last.kids[kid.id];
    return `<p class="status is-clear">Paid <span class="money">${formatMoney(share.cents)}</span> on ${fmtDay(share.paidOn)}</p>`;
  }
  return '<p class="status is-clear">First payday coming up</p>';
}

function renderKids(state) {
  const box = $('kids');
  box.innerHTML = '';

  state.kids.forEach((kid, index) => {
    const card = document.createElement('article');
    card.className = 'kid';
    card.style.setProperty('--kid', colorOf(index));
    card.innerHTML = `
      <div class="kid-head">
        <span class="avatar">${esc(kid.emoji)}</span><h2>${esc(kid.name)}</h2>
        ${tierBadge(kid.points)}
      </div>
      <p class="score${kid.points < 0 ? ' under' : ''}">${kid.points > 0 ? '+' : ''}${kid.points}</p>
      <p class="worth">${worthLine(kid.points, state.config)}</p>
      <div class="pips"></div>
      <p class="trophies">${trophies(kid)}</p>
      ${unlocked ? `<div class="controls">
        <button class="minus" data-bump="-1" data-kid="${esc(kid.id)}" aria-label="Take a point from ${esc(kid.name)}">−</button>
        <button class="plus" data-bump="1" data-kid="${esc(kid.id)}" aria-label="Give ${esc(kid.name)} a point">+</button>
      </div>
      <div class="cardtools">
        <button class="tool" data-zero="${esc(kid.id)}">Reset ${esc(kid.name)}'s week</button>
      </div>` : ''}
      <div class="statuses">${kidStatus(state, kid)}</div>`;
    card.querySelector('.pips').append(pipsFor(kid.points, state.config, false));
    box.append(card);
  });
}

function tierBadge(points) {
  const tier = tierFor(points);
  if (tier) return `<span class="tier" style="--tier:${tier.color}">${tier.emoji} ${tier.name}</span>`;
  const next = nextTier(points);
  return next ? `<span class="tier next">${next.at - points} to ${next.name}</span>` : '';
}

function worthLine(points, config) {
  const money = formatMoney(centsFor(points, config));
  if (points === 0) return `${money} this week`;
  const moved = formatMoney(Math.abs(centsFor(points, config) - baselineCents(config)));
  return points > 0 ? `${money} this week — ${moved} bonus` : `${money} this week — ${moved} lost`;
}

function trophies(kid) {
  const won = [];
  if (kid.points > 0 && kid.points > (kid.best || 0)) won.push('<span class="trophy">👑 Best week yet</span>');
  if ((kid.streak || 0) >= 2) won.push(`<span class="trophy">🔥 ${kid.streak} weeks running</span>`);
  return won.join('');
}

/**
 * The dots are the money. One per point's worth of the guaranteed allowance,
 * all lit at zero: losing points puts them out from the end, earning points
 * stacks gold ones on past the guarantee. A kid can see what they hold and
 * what they stand to lose without reading a number.
 */
function pipsFor(points, config, pop) {
  const frag = document.createDocumentFragment();
  let index = 0;

  const dot = (kind, fresh) => {
    const pip = document.createElement('i');
    pip.className = kind;
    if ((index + 1) % 5 === 0) pip.classList.add('gap');
    if (fresh) pip.classList.add('fresh');
    frag.append(pip);
    index++;
  };

  // A tiny rate would ask for hundreds of dots; show as many as stay readable.
  const slots = Math.min(baselineSlots(config), MAX_PIPS);
  const lost = Math.min(Math.max(0, -points), slots);
  const bonus = Math.max(0, points);

  for (let i = 0; i < slots - lost; i++) dot('on', false);
  for (let i = 0; i < lost; i++) dot('lost', pop && i === lost - 1);
  for (let i = 0; i < Math.min(bonus, MAX_PIPS); i++) dot('over', pop && i === bonus - 1);

  if (bonus > MAX_PIPS) {
    const more = document.createElement('b');
    more.textContent = `+${bonus - MAX_PIPS}`;
    frag.append(more);
  }
  return frag;
}

function renderWeeks(state) {
  const box = $('history');
  box.innerHTML = '';

  const open = outstanding(state);
  // A week nobody was owed anything for is noise in the ledger, not history.
  const done = settled(state).filter(p => Object.values(p.kids).some(k => k.cents > 0)).slice(0, 4);

  if (open.length) box.append(weekList(state, 'Not paid yet', open, true));
  if (done.length) box.append(weekList(state, 'Already paid', done, false));
}

function weekList(state, heading, payouts, open) {
  const section = document.createElement('section');

  const rows = payouts.map(p => {
    const amounts = state.kids.map((k, i) => {
      const share = p.kids[k.id];
      if (!share) return '';
      const mark = share.cents === 0 ? '' : share.paid ? ' <span class="tick">✓</span>' : '';
      return `<span class="who" style="color:${colorOf(i)}">${esc(k.name)}</span> ${formatMoney(share.cents)}${mark}`;
    }).filter(Boolean).join(' &nbsp; ');

    // Friday is usually one action, so keep a way to settle all three at once.
    const tail = open && unlocked
      ? `<button class="edit" data-payweek="${esc(p.id)}">Pay everyone</button>`
      : '';

    return `<li><span class="when">${fmtRange(p.weekStart, p.weekEnd)}</span> ${amounts} ${tail}</li>`;
  }).join('');

  section.innerHTML = `<h2>${heading}</h2><ul>${rows}</ul>`;
  return section;
}

function renderLists(state) {
  for (const kind of ['positive', 'negative']) {
    const list = $(`list-${kind}`);
    const items = state.behaviors[kind] || [];
    list.innerHTML = items.length
      ? items.map(b => `
        <li class="${unlocked ? 'tappable' : ''}" data-behavior="${esc(b.id)}" data-kind="${kind}">
          <span class="label">${esc(b.label)}</span>
          <span class="value">${b.points > 0 ? '+' : ''}${b.points}</span>
          ${unlocked ? `<button class="edit" data-edit="${esc(b.id)}" data-kind="${kind}">Edit</button>` : ''}
        </li>`).join('')
      : `<li class="empty">Nothing here yet.</li>`;
    list.parentElement.querySelector('.add-row').hidden = !unlocked;
  }
}

/* ---------------- parent actions ---------------- */

function bump(kidId, delta) {
  pending.deltas[kidId] = (pending.deltas[kidId] || 0) + delta;
  patchKid(kidId, delta > 0);
  queueSave();
}

/**
 * Update one card in place rather than re-rendering the board. Rebuilding the
 * grid would replace the very button the parent is tapping, which loses the
 * press state mid-tap and drops rapid taps on a touchscreen.
 */
function patchKid(kidId, pop) {
  const state = view();
  const index = state.kids.findIndex(k => k.id === kidId);
  const kid = state.kids[index];
  const card = $('kids').children[index];
  if (!kid || !card) return render();

  const score = card.querySelector('.score');
  score.textContent = `${kid.points > 0 ? '+' : ''}${kid.points}`;
  score.classList.toggle('under', kid.points < 0);
  card.querySelector('.worth').textContent = worthLine(kid.points, state.config);
  card.querySelector('.trophies').innerHTML = trophies(kid);
  card.querySelector('.kid-head .tier')?.remove();
  card.querySelector('.kid-head').insertAdjacentHTML('beforeend', tierBadge(kid.points));
  card.querySelector('.pips').replaceChildren(pipsFor(kid.points, state.config, pop));
  checkMilestones(state, kidId);
}

/* ---------------- milestones ---------------- */

/**
 * Each device remembers what it has already shown for each kid, so the parent
 * gets confetti when they tap and the kid gets their own the first time they
 * open the page afterwards. When a score drops — a new week, or points taken
 * away — the note rewinds quietly so nothing fires twice.
 */
function lastShown(kidId) {
  try { return JSON.parse(localStorage.getItem(`kp.seen.${kidId}`)) || {}; } catch { return {}; }
}

function rememberShown(kidId, signature) {
  try { localStorage.setItem(`kp.seen.${kidId}`, JSON.stringify(signature)); } catch { /* private window */ }
}

function checkMilestones(state, onlyKidId) {
  let stagger = 0;
  state.kids.forEach((kid, index) => {
    if (onlyKidId && kid.id !== onlyKidId) return;

    const now = milestones(state, kid);
    const seen = lastShown(kid.id);
    const tier = TIERS[now.tier - 1];

    // Highest first, one burst at a time.
    const won =
      now.bonus > (seen.bonus || 0) ? { emoji: '✨', text: 'In bonus' } :
      now.tier > (seen.tier || 0) && tier ? { emoji: tier.emoji, text: tier.name, color: tier.color } :
      now.best > (seen.best || 0) ? { emoji: '👑', text: 'Best week yet' } :
      now.streak > (seen.streak || 0) && now.streak >= 2 ? { emoji: '🔥', text: `${now.streak} weeks running` } :
      null;

    rememberShown(kid.id, now);
    if (!won) return;

    setTimeout(() => celebrate(index, won), stagger);
    stagger += 400;
  });
}

function celebrate(index, won) {
  const card = $('kids').children[index];
  if (!card) return;

  const cheer = document.createElement('div');
  cheer.className = 'cheer';
  if (won.color) cheer.style.setProperty('--tier', won.color);
  cheer.innerHTML = `<span class="cheer-emoji">${won.emoji}</span><span>${esc(won.text)}</span>`;
  card.append(cheer);

  const score = card.querySelector('.score');
  score?.classList.add('bounce');
  setTimeout(() => score?.classList.remove('bounce'), 800);
  setTimeout(() => cheer.remove(), 2200);

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) throwConfetti(card);
}

function throwConfetti(card) {
  // Bits live on the body, not the card, so the card can keep clipping its
  // own corners while the confetti sprays past them.
  const box = card.getBoundingClientRect();
  const originX = box.left + box.width / 2;
  const originY = box.top + box.height * 0.35;
  const colors = ['#f4718b', '#6e7bf2', '#2bb3a3', '#f0a500', '#a755d6'];

  for (let i = 0; i < 24; i++) {
    const bit = document.createElement('i');
    bit.className = 'confetti';
    bit.style.background = colors[i % colors.length];
    bit.style.left = `${originX}px`;
    bit.style.top = `${originY}px`;
    bit.style.setProperty('--x', `${(Math.random() * 2 - 1) * 110}px`);
    bit.style.setProperty('--y', `${-70 - Math.random() * 90}px`);
    bit.style.setProperty('--spin', `${Math.random() * 720 - 360}deg`);
    bit.style.setProperty('--fall', `${1 + Math.random() * 0.6}s`);
    document.body.append(bit);
    setTimeout(() => bit.remove(), 1900);
  }
}

function op(operation) {
  pending.ops.push(operation);
  render();
  queueSave(0);
}

/* ---------------- wiring ---------------- */

document.addEventListener('click', event => {
  const target = event.target.closest('[data-bump],[data-paid],[data-payweek],[data-zero],[data-edit],[data-behavior],[data-add]');
  if (!target || !unlocked) return;

  if (target.dataset.bump) return bump(target.dataset.kid, Number(target.dataset.bump));
  if (target.dataset.paid) {
    return op({ type: 'markPaid', payoutId: target.dataset.paid, kidId: target.dataset.kid, on: today });
  }
  if (target.dataset.payweek) return op({ type: 'markWeekPaid', payoutId: target.dataset.payweek, on: today });
  if (target.dataset.zero) return confirmZero(target.dataset.zero);
  if (target.dataset.add) return editBehavior(target.dataset.add, null);
  if (target.dataset.edit) return editBehavior(target.dataset.kind, target.dataset.edit);
  if (target.dataset.behavior) return pickKid(target.dataset.kind, target.dataset.behavior);
});

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[role="tab"]')) {
      const on = other === tab;
      other.setAttribute('aria-selected', String(on));
      $(other.getAttribute('aria-controls')).hidden = !on;
    }
  });
}

$('parent-btn').addEventListener('click', () => (unlocked ? openSettings() : openUnlock()));

window.addEventListener('beforeunload', event => {
  if (pendingCount(pending)) event.preventDefault();
});

/* ---------------- dialogs ---------------- */

// Secondary dialog actions are plain buttons, not submit buttons: the first
// submit button in a form is what Enter triggers, and Cancel sits before the
// primary action. As submit buttons they silently swallowed the Enter key.
document.addEventListener('click', event => {
  const closer = event.target.closest('[data-close]');
  if (closer) closer.closest('dialog').close(closer.dataset.close);
});

function openUnlock() {
  const first = !readToken();
  $('wrap-token').hidden = !first;
  $('unlock-forget').hidden = first;
  $('in-token').value = '';
  $('in-pw').value = '';
  $('unlock-error').hidden = true;
  $('label-pw').textContent = first ? 'Pick a password for this device' : 'Password';
  $('in-pw').autocomplete = first ? 'new-password' : 'current-password';
  $('unlock-note').textContent = first
    ? 'Paste the GitHub token once. It stays in this browser, and the password keeps the buttons out of small hands.'
    : '';
  $('unlock-ok').textContent = first ? 'Set up' : 'Unlock';
  $('dlg-unlock').showModal();
  setTimeout(() => (first ? $('in-token') : $('in-pw')).focus(), 50);
}

$('form-unlock').addEventListener('submit', async event => {
  if (event.submitter?.value !== 'ok') return;
  const first = !readToken();
  const password = $('in-pw').value;

  if (first) {
    const token = $('in-token').value.trim();
    if (!token || !password) {
      event.preventDefault();
      showUnlockError('Both the token and a password are needed.');
      return;
    }
    localStorage.setItem('kp.token', token);
    localStorage.setItem('kp.pw', await sha256(password));
    unlocked = true;
    load();
    return;
  }

  if (await sha256(password) !== readPwHash()) {
    event.preventDefault();
    showUnlockError('That is not the password.');
    return;
  }
  unlocked = true;
  render();
});

// Without this the only way out of a forgotten password is clearing site data,
// because "Forget this device" lives in Settings, which needs you unlocked.
$('unlock-forget').addEventListener('click', () => {
  forgetDevice();
  $('dlg-unlock').close('cancel');
  render();
  openUnlock();
});

function showUnlockError(message) {
  $('unlock-error').textContent = message;
  $('unlock-error').hidden = false;
  $('in-pw').value = '';
  $('in-pw').focus();
}

function pickKid(kind, behaviorId) {
  const state = view();
  const behavior = (state.behaviors[kind] || []).find(b => b.id === behaviorId);
  if (!behavior) return;

  $('pick-title').textContent = `${behavior.label} — who?`;
  $('pick-row').innerHTML = state.kids.map((k, i) =>
    `<button value="${esc(k.id)}" style="--kid:${colorOf(i)}"><span class="avatar">${esc(k.emoji)}</span>${esc(k.name)}</button>`
  ).join('');
  $('dlg-pick').showModal();
  $('dlg-pick').addEventListener('close', function once() {
    $('dlg-pick').removeEventListener('close', once);
    const chosen = $('dlg-pick').returnValue;
    if (chosen && chosen !== 'cancel') bump(chosen, behavior.points);
  });
}

function editBehavior(kind, behaviorId) {
  const state = view();
  const existing = behaviorId ? (state.behaviors[kind] || []).find(b => b.id === behaviorId) : null;
  const losing = kind === 'negative';

  $('behavior-title').textContent = existing ? 'Edit' : losing ? 'Add a way to lose points' : 'Add a way to earn points';
  $('label-bpoints').textContent = losing ? 'Points to lose' : 'Points to earn';
  $('in-blabel').value = existing ? existing.label : '';
  $('in-bpoints').value = existing ? Math.abs(existing.points) : 2;
  $('behavior-delete').hidden = !existing;
  $('dlg-behavior').showModal();

  $('dlg-behavior').addEventListener('close', function once() {
    $('dlg-behavior').removeEventListener('close', once);
    const choice = $('dlg-behavior').returnValue;
    if (choice === 'cancel') return;

    const behaviors = structuredClone(view().behaviors);
    const list = behaviors[kind] || (behaviors[kind] = []);

    if (choice === 'delete') {
      behaviors[kind] = list.filter(b => b.id !== behaviorId);
    } else {
      const magnitude = Math.abs(Number($('in-bpoints').value)) || 1;
      const entry = {
        id: existing ? existing.id : `${kind[0]}${Date.now().toString(36)}`,
        label: $('in-blabel').value.trim() || 'Untitled',
        points: losing ? -magnitude : magnitude,
      };
      const at = list.findIndex(b => b.id === entry.id);
      if (at >= 0) list[at] = entry; else list.push(entry);
    }
    op({ type: 'setBehaviors', behaviors });
  });
}

function openSettings() {
  const state = view();
  $('in-base').value = (baselineCents(state.config) / 100).toFixed(2);
  $('in-rate').value = state.config.centsPerPoint;
  $('in-tz').value = state.config.timezone;
  $('rate-hint').textContent =
    `${baselineSlots(state.config)} points either way is the whole allowance.`;
  $('kid-editors').innerHTML = state.kids.map(k => `
    <div>
      <input type="text" class="emoji" value="${esc(k.emoji)}" data-emoji="${esc(k.id)}" aria-label="Emoji for ${esc(k.name)}" maxlength="4">
      <input type="text" value="${esc(k.name)}" data-name="${esc(k.id)}" aria-label="Name" maxlength="20">
    </div>`).join('');
  $('dlg-settings').showModal();
}

$('form-settings').addEventListener('submit', event => {
  if (event.submitter?.value !== 'ok') return;
  const kids = view().kids.map(k => ({
    ...k,
    name: document.querySelector(`[data-name="${CSS.escape(k.id)}"]`).value.trim() || k.name,
    emoji: document.querySelector(`[data-emoji="${CSS.escape(k.id)}"]`).value.trim() || k.emoji,
  }));
  pending.ops.push({ type: 'setKids', kids });
  pending.ops.push({
    type: 'setConfig',
    config: {
      baselineCents: Math.max(0, Math.round((Number($('in-base').value) || 10) * 100)),
      centsPerPoint: Math.max(1, Number($('in-rate').value) || 25),
      timezone: $('in-tz').value.trim() || 'UTC',
    },
  });
  render();
  queueSave(0);
});

/** Resetting one kid lives on their own card, not in Settings. */
function confirmZero(kidId) {
  const kid = view().kids.find(k => k.id === kidId);
  if (!kid) return;
  confirmThen(
    `Reset ${kid.name}'s week?`,
    `${kid.name} goes back to 0 points, which is the plain allowance again. Their best week, their streak and anything they are owed are left alone.`,
    null,
    () => op({ type: 'zeroKid', kidId }));
}

$('btn-payall').addEventListener('click', () => confirmThen(
  'Mark everything paid?', 'Every week that is still owed gets marked paid today.', null,
  () => { $('dlg-settings').close('cancel'); op({ type: 'markAllPaid', on: today }); }));

$('btn-startover').addEventListener('click', () => confirmThen(
  'Start over?', 'Every payout record is deleted and all three go back to 0. Your earn and lose lists stay.', 'start over',
  () => { $('dlg-settings').close('cancel'); op({ type: 'startOver', startDate: view().cycle.startDate }); }));

$('btn-forget').addEventListener('click', () => confirmThen(
  'Forget this device?', 'The token and password are deleted from this browser. You will paste the token again next time.', null,
  () => { $('dlg-settings').close('cancel'); forgetDevice(); render(); }));

function confirmThen(title, body, word, action) {
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-wrap').hidden = !word;
  $('confirm-word').textContent = word || '';
  $('in-confirm').value = '';
  $('dlg-confirm').showModal();

  $('dlg-confirm').addEventListener('close', function once() {
    $('dlg-confirm').removeEventListener('close', once);
    if ($('dlg-confirm').returnValue !== 'ok') return;
    if (word && $('in-confirm').value.trim().toLowerCase() !== word) return;
    action();
  });
}

load();
