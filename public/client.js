'use strict';
/* global io */

const socket = io();
const $ = (id) => document.getElementById(id);
let state = null;

// sessionStorage is per-tab, so several tabs in one browser get separate seats,
// while a refresh in the same tab reconnects to the same seat.
const SESSION_KEY = 'callbridge-session';
const saveSession = (s) => sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
const loadSession = () => {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
};
const clearSession = () => sessionStorage.removeItem(SESSION_KEY);
const pref = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ---------- helpers ----------
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SEAT_COLORS = ['#14b8a6', '#8b5cf6', '#f59e0b', '#f43f5e'];
const suitOf = (c) => c.slice(-1);
const rankOf = (c) => parseInt(c, 10);
const cardName = (c) => `${RANK_LABEL[rankOf(c)] || rankOf(c)}${SUIT_SYMBOL[suitOf(c)]}`;
const callName = (b) => (b === null || b === undefined ? '—' : b === 0 ? 'Nil' : String(b));
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const initial = (name) => esc((String(name).trim()[0] || '?').toUpperCase());

function cardEl(card, { small = false, back = false } = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (small ? ' small' : '');
  if (back) { el.classList.add('back'); return el; }
  const s = suitOf(card);
  const r = RANK_LABEL[rankOf(card)] || String(rankOf(card));
  if (s === 'H' || s === 'D') el.classList.add('red');
  const sym = SUIT_SYMBOL[s];
  el.innerHTML =
    `<div class="corner tl"><span>${r}</span><span>${sym}</span></div>` +
    `<div class="pip">${sym}</div>` +
    `<div class="corner br"><span>${r}</span><span>${sym}</span></div>`;
  el.title = `${r}${sym}`;
  return el;
}

function avatarHtml(seat, name) {
  return `<div class="avatar" style="--c:${SEAT_COLORS[seat % SEAT_COLORS.length]}">${initial(name)}</div>`;
}

let toastTimer;
function toast(msg, kind = 'error') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast glass ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'info' ? 4500 : 2800);
}

function emit(event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => {
      if (!res || !res.ok) toast(res ? res.error : 'No response from server');
      resolve(res || { ok: false });
    });
  });
}

function show(screen) {
  for (const id of ['screen-home', 'screen-lobby', 'screen-table', 'screen-final']) {
    $(id).classList.toggle('hidden', id !== screen);
  }
}

// ---------- animation clock ----------
// Animations are keyed by what they show (a card in a trick, a finished trick,
// a deal) and started with a negative delay equal to the time already elapsed.
// So re-rendering mid-animation continues it seamlessly instead of restarting,
// and anything already on screen when the page loads doesn't animate at all.
const firstSeen = new Map();
let primed = false; // false until the first render, so a reload doesn't replay animations
function since(key) {
  if (!firstSeen.has(key)) firstSeen.set(key, primed ? performance.now() : -1e9);
  return performance.now() - firstSeen.get(key);
}
// Applies `name` if it's still running; returns false once it has finished.
function animate(el, name, ms, elapsed, easing = 'cubic-bezier(.2,.8,.25,1)') {
  if (elapsed >= ms) return false;
  el.style.animation = `${name} ${ms}ms ${easing} ${-elapsed}ms both`;
  return true;
}
const CARD_IN_MS = 420;
const COLLECT_MS = 1900; // the trick stays visible ~1s, then slides to the winner
const DEAL_MS = 480;
const DEAL_STAGGER = 55;
const FAN_DEG = 2; // rotation between neighbouring cards in my hand

// ---------- home / lobby / overlays ----------
$('name').value = pref.get('callbridge-name') || '';
const getName = () => {
  const n = $('name').value.trim();
  if (!n) { toast('Please enter your name'); $('name').focus(); return null; }
  pref.set('callbridge-name', n);
  return n;
};

$('btn-create').onclick = async () => {
  const name = getName(); if (!name) return;
  const res = await emit('create', { name });
  if (res.ok) saveSession({ code: res.code, token: res.token });
};
$('btn-join').onclick = async () => {
  const name = getName(); if (!name) return;
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Enter the 4-letter room code');
  const res = await emit('join', { code, name });
  if (res.ok) saveSession({ code: res.code, token: res.token });
};
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });

async function leave() {
  await emit('leave');
  clearSession();
  state = null;
  show('screen-home');
}
$('btn-leave').onclick = leave;
$('btn-final-leave').onclick = leave;
$('btn-start').onclick = () => emit('start');
$('btn-again').onclick = () => emit('backToLobby');

const OVERLAYS = ['scoreboard', 'rules', 'confirm-exit', 'past-games'];
const openOverlay = (id) => $(id).classList.remove('hidden');
const closeOverlays = () => OVERLAYS.forEach((id) => $(id).classList.add('hidden'));
$('btn-scores').onclick = () => { renderScoreTable($('score-table')); openOverlay('scoreboard'); };
document.querySelectorAll('.btn-rules').forEach((b) => (b.onclick = () => openOverlay('rules')));
for (const id of OVERLAYS) {
  const ov = $(id);
  ov.onclick = (e) => { if (e.target === ov || e.target.classList.contains('btn-close')) ov.classList.add('hidden'); };
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });

// Exit mid-game: confirm first, because it ends the game for everyone.
$('btn-exit').onclick = () => { openOverlay('confirm-exit'); $('btn-exit-stay').focus(); };
$('btn-exit-stay').onclick = () => $('confirm-exit').classList.add('hidden');
$('btn-exit-leave').onclick = () => { closeOverlays(); leave(); };

// Past games (home screen), from the server's saved history.
$('btn-past').onclick = async () => {
  const list = $('past-list');
  list.innerHTML = '<p class="past-empty">Loading…</p>';
  openOverlay('past-games');
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderPastGames(await res.json());
  } catch (err) {
    list.innerHTML = `<p class="past-empty">Couldn't load past games (${esc(err.message)}).</p>`;
  }
};

function renderPastGames(games) {
  const list = $('past-list');
  if (!games.length) { list.innerHTML = '<p class="past-empty">No finished games yet.</p>'; return; }
  list.innerHTML = games.map((r) => {
    const winners = r.winners.map(esc).join(' &amp; ') || 'nobody';
    const result = r.ended.type === 'left'
      ? `${esc(r.ended.player)} left the game · ${r.winners.length > 1 ? 'shared win' : 'winner'}: ${winners}`
      : `${winners} won`;
    const totals = r.totals.map((t) => {
      const won = r.winners.includes(t.name);
      return `<span class="stat${won ? ' win' : ''}">${won ? '🏆 ' : ''}${esc(t.name)} <b>${t.score}</b></span>`;
    }).join('');
    const head = r.players.map((n) => `<th>${esc(n)}</th>`).join('');
    const rows = r.rounds.map((rd) => `<tr><td>R${rd.round}</td>` + rd.players.map((p) => {
      const what = p.call === null ? `won ${p.tricks}` : `${p.tricks}/${callName(p.call)}`;
      return `<td class="${p.points < 0 ? 'neg' : 'pos'}">${what} → ${signed(p.points)}</td>`;
    }).join('') + '</tr>').join('') ||
      `<tr><td colspan="${r.players.length + 1}">Ended before any round finished</td></tr>`;
    return `<article class="past-game">` +
      `<div class="past-top"><span>${esc(new Date(r.date).toLocaleString())}</span>` +
      `<span>Room <b>${esc(r.room)}</b> · ${r.rounds.length} round${r.rounds.length === 1 ? '' : 's'}</span></div>` +
      `<div class="past-result${r.ended.type === 'left' ? ' left' : ''}">${result}</div>` +
      `<div class="past-totals">${totals}</div>` +
      `<details><summary>Round by round</summary><div class="table-scroll"><table class="scores">` +
      `<thead><tr><th>Round</th>${head}</tr></thead><tbody>${rows}</tbody></table></div></details>` +
      `</article>`;
  }).join('');
}

// Collapsible live scoreboard (remembered per browser)
function setScorePanelCollapsed(collapsed) {
  $('scorepanel').classList.toggle('collapsed', collapsed);
  $('sp-toggle').setAttribute('aria-expanded', String(!collapsed));
  pref.set('callbridge-sp-collapsed', collapsed ? '1' : '0');
  requestAnimationFrame(layoutFixups);
}
setScorePanelCollapsed(pref.get('callbridge-sp-collapsed') === '1');
$('sp-toggle').onclick = () => setScorePanelCollapsed(!$('scorepanel').classList.contains('collapsed'));

// ---------- socket ----------
socket.on('connect', async () => {
  const s = loadSession();
  if (!s) return show('screen-home');
  const res = await emit('resume', s);
  if (!res.ok) { clearSession(); show('screen-home'); }
});
socket.on('disconnect', () => toast('Disconnected — reconnecting…'));

let clockOffset = 0; // serverTime - localTime
let seenTimeoutId; // undefined until the first game state arrives
socket.on('state', (s) => {
  state = s;
  clockOffset = s.serverNow - Date.now();
  announceTimeout();
  render();
  primed = true;
});

// Tell everyone when a player's timer ran out and which card was revealed.
function announceTimeout() {
  const t = state.game && state.game.lastTimeout;
  const id = t ? t.id : null;
  if (seenTimeoutId !== undefined && id !== null && id !== seenTimeoutId) {
    const who = t.player === state.you ? 'You' : state.players[t.player].name;
    const did = t.played ? `played ${cardName(t.played)}` : `called ${callName(t.call)}`;
    toast(`⏱ ${who} ran out of time — revealed ${cardName(t.revealed)}, auto ${did}`, 'info');
  }
  seenTimeoutId = state.game ? id : undefined;
}

// ---------- render ----------
function render() {
  if (!state) return show('screen-home');
  if (state.phase === 'lobby') return renderLobby();
  if (state.phase === 'gameOver') return renderFinal();
  renderTable();
}

function renderLobby() {
  show('screen-lobby');
  $('lobby-code').textContent = state.code;
  const ul = $('lobby-players');
  ul.innerHTML = '';
  for (let i = 0; i < state.maxPlayers; i++) {
    const p = state.players[i];
    const li = document.createElement('li');
    if (!p) { li.className = 'empty'; li.textContent = 'Open seat'; }
    else {
      li.innerHTML = avatarHtml(i, p.name) +
        `<div class="who"><b>${esc(p.name)}${i === state.you ? ' (you)' : ''}</b><div class="tags">` +
        (i === state.host ? '<span class="tag">HOST</span>' : '') +
        (!p.connected ? '<span class="tag off">OFFLINE</span>' : '') + '</div></div>';
    }
    ul.appendChild(li);
  }
  const isHost = state.you === state.host;
  const count = state.players.length;
  const enough = count >= state.minPlayers;
  $('btn-start').classList.toggle('hidden', !isHost);
  $('btn-start').disabled = !enough;
  $('btn-start').textContent = enough ? `Start game · ${count} players` : 'Start game';
  $('lobby-wait').textContent = !enough
    ? `Need at least ${state.minPlayers} players`
    : isHost ? (count < state.maxPlayers ? 'Start now, or wait for more players' : 'Table is full!')
      : 'Waiting for the host to start…';
}

const numPlayers = () => state.players.length;
const nameOf = (i) => (i === state.you ? 'You' : state.players[i]?.name ?? '?');

// Seats sit counter-clockwise from me: me (bottom) -> right -> top -> left.
function posOf(seat) {
  const n = numPlayers();
  const k = (seat - state.you + n) % n;
  if (k === 0) return 'me';
  if (n === 2) return 'top';
  if (n === 3) return k === 1 ? 'right' : 'left';
  return ['me', 'right', 'top', 'left'][k];
}

const RING_R = 23;
const RING_C = 2 * Math.PI * RING_R;

function renderSeat(el, i) {
  const g = state.game;
  const p = state.players[i];
  const isMe = i === state.you;
  const turn = g.turn === i;
  el.classList.remove('hidden');
  el.classList.toggle('turn', turn);
  el.classList.toggle('offline', !p.connected);

  const call = g.round === 1 ? '—' : callName(g.bids[i]);
  const calling = state.phase === 'bidding' && turn && !isMe;
  let html =
    `<div class="avatar-wrap">` +
    `<svg class="ring" viewBox="0 0 52 52" aria-hidden="true"><circle class="track" cx="26" cy="26" r="${RING_R}"/>` +
    `<circle class="prog" cx="26" cy="26" r="${RING_R}" style="stroke-dasharray:${RING_C};stroke-dashoffset:${turn && state.deadline ? 0 : RING_C}"/></svg>` +
    avatarHtml(i, p.name) +
    (i === g.dealer ? '<span class="dealer" title="Dealer">D</span>' : '') +
    `</div><div class="info">` +
    `<div class="name">${esc(nameOf(i))}${p.connected ? '' : ' <span class="tag off">OFFLINE</span>'}</div>` +
    `<div class="stats"><span class="stat" title="${g.round === 1 ? 'No calls in round 1' : 'Call'}">Call <b>${call}</b></span>` +
    `<span class="stat">Won <b>${g.tricksWon[i]}</b></span></div>` +
    (calling ? '<span class="badge-calling">Calling…</span>' : '') +
    (p.graceUntil && !p.connected ? `<span class="badge-grace" data-grace-until="${p.graceUntil}">Reconnecting…</span>` : '') +
    `</div>`;
  if (!isMe) {
    const backs = Math.min(3, g.handCounts[i]);
    html += `<div class="mini-stack" title="${g.handCounts[i]} cards">` +
      '<div class="card small back"></div>'.repeat(backs) + '</div>';
  }
  el.innerHTML = html;

  const shown = g.revealed.filter((r) => r.player === i);
  if (shown.length) {
    const box = document.createElement('div');
    box.className = 'revealed';
    box.append('Revealed:');
    for (const r of shown) box.appendChild(cardEl(r.card, { small: true }));
    el.appendChild(box);
  }
}

function renderScorePanel() {
  const g = state.game;
  const top = Math.max(...g.scores);
  const hasLeader = g.history.length > 0 && g.scores.some((s) => s !== top);
  const rows = $('sp-rows');
  const prev = renderScorePanel.prev || {};
  rows.innerHTML = '';
  g.scores.forEach((score, i) => {
    const row = document.createElement('div');
    row.className = 'sp-row' + (hasLeader && score === top ? ' leader' : '') + (g.turn === i ? ' turn' : '');
    row.innerHTML =
      `<span class="sp-name"><i style="--c:${SEAT_COLORS[i % SEAT_COLORS.length]}"></i><em>${hasLeader && score === top ? '👑 ' : ''}${esc(nameOf(i))}</em></span>` +
      `<span class="sp-call">${g.round === 1 ? '—' : callName(g.bids[i])}</span>` +
      `<span class="sp-won">${g.tricksWon[i]}</span>` +
      `<span class="sp-total">${score}</span>`;
    const key = `${state.code}:${i}`;
    if (prev[key] !== undefined && prev[key] !== score) row.querySelector('.sp-total').classList.add('bump');
    prev[key] = score;
    rows.appendChild(row);
  });
  renderScorePanel.prev = prev;
  const leaderIdx = g.scores.indexOf(top);
  $('sp-toggle').innerHTML = `<span>🏆 Scores</span>` +
    (hasLeader ? `<span class="sp-leader">${esc(nameOf(leaderIdx))} · ${top}</span>` : '<span class="sp-leader"></span>') +
    `<span class="sp-caret">▾</span>`;
}

function renderBoard() {
  const g = state.game;
  const phase = state.phase;
  const trickEl = $('trick');
  trickEl.innerHTML = '';
  const showCards = phase === 'playing' || phase === 'bidding';

  const addSlot = (player, card, extraClass, cardAnimKey) => {
    const slot = document.createElement('div');
    slot.className = `slot ${posOf(player)} ${extraClass}`;
    const c = cardEl(card);
    animate(c, 'card-in', CARD_IN_MS, since(cardAnimKey));
    slot.appendChild(c);
    if (posOf(player) !== 'me') {
      const label = document.createElement('span');
      label.className = 'slot-name';
      label.textContent = nameOf(player);
      slot.appendChild(label);
    }
    trickEl.appendChild(slot);
    return slot;
  };

  // The finished trick lingers, then slides toward its winner.
  let winnerNote = '';
  if (showCards && g.lastTrick) {
    const lt = g.lastTrick;
    const doneKey = `done:${state.code}:${g.round}:${lt.cards.map((c) => c.card).join(',')}`;
    const elapsed = since(doneKey);
    if (elapsed < COLLECT_MS) {
      for (const { player, card } of lt.cards) {
        const slot = addSlot(player, card, `collecting win-${posOf(lt.winner)}` + (player === lt.winner ? ' won' : ''),
          `card:${state.code}:${g.round}:${card}`);
        animate(slot, 'collect', COLLECT_MS, elapsed, 'ease-in');
      }
      winnerNote = lt.winner === state.you ? 'You take the trick!' : `${nameOf(lt.winner)} takes the trick`;
    }
  }
  if (showCards) {
    for (const { player, card } of g.trick) addSlot(player, card, '', `card:${state.code}:${g.round}:${card}`);
  }

  // Status pill
  const myTurn = g.turn === state.you;
  const status = $('status');
  status.classList.toggle('mine', myTurn);
  let text = '';
  if (phase === 'bidding') text = myTurn ? 'Your turn to call' : `${nameOf(g.turn)} is calling…`;
  else if (phase === 'playing') text = myTurn ? 'Your turn — play a card' : `${nameOf(g.turn)} is playing…`;
  status.innerHTML = phase === 'roundEnd' ? '' :
    `<div class="status-main">${esc(text)}${state.deadline ? '<span class="clock"></span>' : ''}</div>` +
    (winnerNote ? `<div class="status-sub">${esc(winnerNote)}</div>` : '');

  // Round end summary on the board
  const re = $('round-end');
  re.classList.toggle('hidden', phase !== 'roundEnd');
  if (phase === 'roundEnd') {
    const h = g.history[g.history.length - 1];
    const rows = h.deltas.map((d, i) =>
      `<tr><td>${esc(nameOf(i))}</td><td>${callName(h.bids[i])}</td><td>${h.tricks[i]}</td>` +
      `<td class="${d < 0 ? 'neg' : 'pos'}">${signed(d)}</td><td><b>${g.scores[i]}</b></td></tr>`).join('');
    re.innerHTML = `<h3>Round ${g.round} results</h3>` +
      `<table class="scores"><thead><tr><th></th><th>Call</th><th>Won</th><th>Points</th><th>Total</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
    const btn = document.createElement('button');
    btn.id = 'btn-next-round';
    btn.className = 'btn primary';
    btn.textContent = 'Deal next round';
    btn.onclick = () => emit('nextRound');
    re.appendChild(btn);
  }
}

function renderHand() {
  const g = state.game;
  const me = state.you;
  const handEl = $('hand');
  handEl.innerHTML = '';
  const playing = state.phase === 'playing' && g.turn === me;
  handEl.classList.toggle('my-turn', playing);
  const myRevealed = new Set(g.revealed.filter((r) => r.player === me).map((r) => r.card));
  const n = g.hand.length;
  const mid = (n - 1) / 2;
  const dealElapsed = since(`deal:${state.code}:${g.round}`);
  g.hand.forEach((c, i) => {
    const el = cardEl(c);
    // gentle fan: rotate around a point below the hand, middle cards raised a little
    const off = i - mid;
    el.style.setProperty('--rot', `${(off * FAN_DEG).toFixed(2)}deg`);
    el.style.setProperty('--dy', `${((off * off - mid * mid) * 0.5).toFixed(1)}px`);
    if (myRevealed.has(c)) { el.classList.add('revealed-mine'); el.title += ' (revealed to everyone)'; }
    if (playing && g.legal.includes(c)) {
      el.classList.add('legal');
      el.tabIndex = 0;
      el.onclick = () => emit('play', { card: c });
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('play', { card: c }); } };
    }
    animate(el, 'deal', DEAL_MS, dealElapsed - i * DEAL_STAGGER, 'cubic-bezier(.2,.9,.3,1.1)');
    handEl.appendChild(el);
  });
}

function renderBidPicker() {
  const g = state.game;
  const picker = $('bid-picker');
  const show = state.phase === 'bidding' && g.turn === state.you && g.callOptions.length > 0;
  picker.classList.toggle('hidden', !show);
  if (!show) return;
  const box = $('bid-buttons');
  box.innerHTML = '';
  for (const b of g.callOptions) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b === 0 ? ' nil' : '');
    btn.textContent = callName(b);
    if (b === 0) btn.title = 'Nil: win no tricks for +10, or −10 if you win any';
    btn.onclick = () => emit('bid', { bid: b });
    box.appendChild(btn);
  }
}

function renderTable() {
  show('screen-table');
  const g = state.game;
  $('screen-table').dataset.phase = state.phase;
  $('t-code').textContent = state.code;
  $('t-round').textContent = `Round ${g.round}${g.round === 1 ? ' · no calls' : ''} · first to ${g.targetScore}`;

  const used = new Set();
  for (let i = 0; i < numPlayers(); i++) {
    const pos = posOf(i);
    used.add(pos);
    renderSeat($(`seat-${pos}`), i);
  }
  for (const pos of ['top', 'left', 'right']) if (!used.has(pos)) $(`seat-${pos}`).classList.add('hidden');

  renderScorePanel();
  renderBoard();
  renderBidPicker();
  renderHand();
  if (!$('scoreboard').classList.contains('hidden')) renderScoreTable($('score-table'));
  tickTimer();
  requestAnimationFrame(layoutFixups);
}

// ---------- layout fix-ups that CSS alone can't do ----------
function layoutFixups() {
  if ($('screen-table').classList.contains('hidden')) return;
  // 1. Fit the fanned hand into the available width. Rotation around a point
  //    below the cards swings the outer ones further out, so reserve room for it.
  const hand = $('hand');
  const cards = hand.children.length;
  if (cards > 1) {
    const cardW = hand.firstElementChild.offsetWidth;
    const cardH = hand.firstElementChild.offsetHeight;
    const maxRot = (((cards - 1) / 2) * FAN_DEG * Math.PI) / 180;
    const swing = cardH * 1.4 * Math.sin(maxRot);
    const avail = hand.clientWidth - 16 - 2 * swing;
    const step = Math.max(10, Math.min(cardW * 0.62, (avail - cardW) / (cards - 1)));
    hand.style.setProperty('--overlap', `${Math.round(step - cardW)}px`);
  }
  // 2. On a short board, shrink trick cards (toward their edge) so they clear
  //    the status pill in the middle. Full size whenever there's room.
  const feltH = document.querySelector('.felt').clientHeight;
  const cardH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-h')) || 120;
  const statusH = $('status').offsetHeight || 34;
  const room = feltH * 0.45 - statusH / 2 - 8; // from the edge inset to just short of the pill
  const hasTop = numPlayers() % 2 === 0; // 2 or 4 players put a card at the top
  const scale = Math.max(0.55, Math.min(1, room / cardH, hasTop ? room / (cardH + 20) : 1));
  $('board').style.setProperty('--board-scale', scale.toFixed(3));
}
window.addEventListener('resize', () => requestAnimationFrame(layoutFixups));

// Updates the countdown in the status pill and the ring on the active seat.
function tickTimer() {
  if (!state || !state.deadline || state.phase === 'lobby') return;
  const left = Math.max(0, state.deadline - (Date.now() + clockOffset));
  const secs = Math.ceil(left / 1000);
  const low = secs <= 5;
  const clock = document.querySelector('#status .clock');
  if (clock) { clock.textContent = `${secs}s`; clock.classList.toggle('low', low); }
  const ring = document.querySelector('.seat.turn .ring');
  if (ring) {
    ring.classList.toggle('low', low);
    ring.querySelector('.prog').style.strokeDashoffset = String(RING_C * (1 - left / state.turnMs));
  }
}
// "Reconnecting… 45s" on a dropped player's seat: the game ends when it hits 0.
function tickGrace() {
  for (const el of document.querySelectorAll('[data-grace-until]')) {
    const secs = Math.max(0, Math.ceil((Number(el.dataset.graceUntil) - (Date.now() + clockOffset)) / 1000));
    el.textContent = `Reconnecting… ${secs}s`;
  }
}
setInterval(() => { tickTimer(); tickGrace(); }, 250);

function renderScoreTable(container) {
  const g = state.game;
  if (!g) { container.innerHTML = ''; return; }
  const seats = g.scores.map((_, i) => i);
  const names = seats.map((i) => `<th>${esc(nameOf(i))}</th>`).join('');
  const body = g.history.map((h, r) =>
    `<tr><td>R${r + 1}</td>` + seats.map((i) => {
      const what = h.bids[i] === null ? `won ${h.tricks[i]}` : `${h.tricks[i]}/${callName(h.bids[i])}`;
      return `<td class="${h.deltas[i] < 0 ? 'neg' : 'pos'}">${what} → ${signed(h.deltas[i])}</td>`;
    }).join('') + '</tr>').join('') ||
    `<tr><td colspan="${seats.length + 1}">No rounds finished yet</td></tr>`;
  const total = seats.map((i) => `<td>${g.scores[i]}</td>`).join('');
  container.innerHTML =
    `<div class="table-scroll"><table class="scores"><thead><tr><th>Round</th>${names}</tr></thead>` +
    `<tbody>${body}</tbody><tfoot><tr><td>Total</td>${total}</tr></tfoot></table></div>` +
    `<p class="sub">Cells show won/call → points (round 1: 1 point per trick). First to ${g.targetScore} wins.</p>`;
}

function renderFinal() {
  show('screen-final');
  closeOverlays();
  const g = state.game;
  const winners = g.winners;
  const winnerNames = winners.map(nameOf);
  $('final-title').textContent = winners.length > 1
    ? `Shared win: ${winnerNames.join(' & ')}`
    : winners[0] === state.you ? 'You win!' : `${winnerNames[0]} wins!`;
  const leftSeat = g.endReason && g.endReason.type === 'left' ? g.endReason.player : null;
  $('final-reason').classList.toggle('hidden', leftSeat === null);
  if (leftSeat !== null) $('final-reason').textContent = `${state.players[leftSeat].name} left the game`;
  // Tied winners all get gold, the rest are placed after them, and the leaver gets no medal.
  const medals = ['🥇', '🥈', '🥉', '4'];
  let place = winners.length;
  $('final-list').innerHTML = g.standings.map((x) => {
    const won = winners.includes(x.player);
    const medal = x.left ? '—' : won ? medals[0] : medals[place++];
    return `<li class="${won ? 'first' : ''}${x.left ? ' gone' : ''}"><span class="rank">${medal}</span>` +
      avatarHtml(x.player, state.players[x.player].name) +
      `<span class="pname">${esc(nameOf(x.player))}${x.left ? ' <span class="tag left">LEFT</span>' : ''}</span>` +
      `<span class="pscore">${x.score}</span></li>`;
  }).join('');
  renderScoreTable($('final-table'));
  const isHost = state.you === state.host;
  $('btn-again').classList.toggle('hidden', !isHost);
  $('final-wait').textContent = isHost ? '' : 'Waiting for the host to return to the lobby…';
}
