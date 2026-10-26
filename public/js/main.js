import { buildArena, sideForSeat } from '../shared/arena.js';
import { BOT_LEVELS } from '../shared/bot.js';
import { hockeyZone } from '../shared/hockey.js';
import { SOCCER, soccerGoal } from '../shared/soccer.js';
import { rotate } from '../shared/vec.js';
import { Connection } from './net.js';
import { FreeInput, PaddleInput, controlsLabel, freeControlsLabel } from './input.js';
import { isTouchDevice, lockLandscape, updateOrientation } from './layout.js';
import { Renderer, viewRotation } from './render.js';
import { SnapshotBuffer } from './snapshots.js';

const MODE_NAMES = { pong: 'Pong', hockey: 'Air hockey', soccer: 'Soccer' };
const SEAT_OPTIONS = [['open', 'Open seat'], ...Object.keys(BOT_LEVELS).map((level) => [level, `Bot · ${level}`])];
const OVER_DELAY_MS = 1200; // let the win animation play before covering the field

const $ = (selector) => document.querySelector(selector);
const renderer = new Renderer($('#field'));
const net = new Connection();
const NO_ROOM = { room: null, seat: null, isAdmin: false };
let lobby = NO_ROOM; // latest `room` message from the server
let match = null;

// The room you're in lives in the URL (/room/CODE), so the link alone is
// enough to share it, and reopening it lands back on the join form.
const ROOM_PATH = /^\/room\/([A-Za-z0-9]+)\/?$/;
const roomLink = (code) => new URL(code ? `/room/${code}` : '/', location.origin);

function setRoomPath(code) {
  const url = roomLink(code);
  url.search = location.search;
  if (url.href !== location.href) history.replaceState(null, '', url);
}

function show(id) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === id);
  // Pins the page while playing so touches can't scroll it or bounce the browser toolbar.
  document.documentElement.classList.toggle('playing', id === 'game');
}

// ?debug shows the longest gap between drawn frames and between server
// updates over the last few seconds, to tell a stalled screen from a slow network.
const debug = new URLSearchParams(location.search).has('debug')
  ? { el: Object.assign(document.body.appendChild(document.createElement('pre')), { className: 'debug' }), frames: [], states: [], resizes: 0 }
  : null;

function trackGap(list, now) {
  list.push(now);
  while (list.length && list[0] < now - 3000) list.shift();
}

function maxGap(list) {
  let max = 0;
  for (let i = 1; i < list.length; i++) max = Math.max(max, list[i] - list[i - 1]);
  return Math.round(max);
}

const activeScreen = () => $('.screen.active')?.id;

function showError(message) {
  const el = $('.screen.active .error');
  if (el) el.textContent = message;
}

function clearErrors() {
  for (const el of document.querySelectorAll('.error')) el.textContent = '';
}

function selectEl(name, value, options) {
  const select = document.createElement('select');
  select.name = name;
  for (const [optValue, label] of options) select.add(new Option(label, optValue, false, optValue === value));
  return select;
}

// ---- Server messages ----

// Who is logged in, as the server sees this connection.
let session = { user: null, loginRequired: false };

net.on('hello', (msg) => {
  session = msg;
  renderSession();
});

function renderSession() {
  const { user, loginRequired } = session;
  $('#admin-actions').hidden = loginRequired && !user;
  $('#session-user').textContent = user ? `Signed in as ${user}` : '';
  $('#go-login').hidden = !loginRequired || Boolean(user);
  $('#logout').hidden = !user;
  if (user) createForm.elements.adminName.value = user.slice(0, 12);
}

net.on('room', (msg) => {
  lobby = msg;
  renderRoom();
  if (!match && activeScreen() !== 'room') {
    clearErrors();
    show('room');
  }
});

net.on('start', ({ seatCount, seat, mode }) => startMatch(seatCount, seat, mode));

net.on('state', ({ ts, s, e, paused }) => {
  if (!match) return;
  match.buffer.push(ts, s, e);
  match.paused = paused;
  if (debug) trackGap(debug.states, performance.now());
});

net.on('end', () => {
  stopMatch();
  show('room');
});

net.on('left', () => {
  setRoomPath(null);
  leaveToHome('');
});
net.on('closed', ({ reason }) => {
  setRoomPath(null);
  leaveToHome(reason);
});
net.on('error', ({ message }) => showError(message));
net.on('down', () => leaveToHome('Lost connection to the server. Reconnecting…'));
net.on('up', () => {
  if ($('#home-error').textContent.startsWith('Lost connection')) $('#home-error').textContent = '';
});

function leaveToHome(message) {
  stopMatch();
  lobby = NO_ROOM;
  clearErrors();
  show('home');
  $('#home-error').textContent = message;
}

// ---- Home ----

$('#go-create').addEventListener('click', () => {
  clearErrors();
  renderSeatConfig();
  show('create');
});

// Opened from a shared link: the code is filled in, so only a name is needed.
{
  const code = ROOM_PATH.exec(location.pathname)?.[1];
  if (code) {
    const form = $('#home-join');
    form.elements.code.value = code.toUpperCase().slice(0, 5);
    form.elements.name.focus();
  }
}

$('#home-join').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  clearErrors();
  net.send({ t: 'join', code: data.get('code'), name: data.get('name') });
});

// ---- Admin login ----

$('#go-login').addEventListener('click', () => {
  clearErrors();
  show('login');
  $('#login-form').elements.username.focus();
});

// The session lives in an HttpOnly cookie, which the WebSocket only sends when
// it connects, so reconnect after logging in or out.
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    e.target.reset();
    net.reconnect();
    clearErrors();
    show('home');
  } catch (err) {
    showError(err.message || 'Could not log in.');
  }
});

$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  net.reconnect();
});

for (const btn of document.querySelectorAll('[data-nav]')) {
  btn.addEventListener('click', () => {
    clearErrors();
    show(btn.dataset.nav);
  });
}

// ---- Create room ----

const createForm = $('#create-form');

createForm.addEventListener('change', (e) => {
  if (['players', 'adminPlays', 'mode'].includes(e.target.name)) renderSeatConfig();
});

function renderSeatConfig() {
  const data = new FormData(createForm);
  const count = Number(data.get('players'));
  const adminPlays = data.get('adminPlays') === 'on';
  const container = $('#seat-config');
  container.replaceChildren();
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('span');
    label.textContent = `Seat ${i + 1}`;
    row.append(label);
    if (adminPlays && i === 0) {
      const you = document.createElement('span');
      you.className = 'muted';
      you.textContent = 'You';
      row.append(you);
    } else {
      row.append(selectEl(`seat${i}`, data.get(`seat${i}`) ?? 'open', SEAT_OPTIONS));
    }
    container.append(row);
  }
  drawPreview($('#preview'), buildArena(count), data.get('mode'));
}

function drawPreview(canvas, arena, mode) {
  const ctx = canvas.getContext('2d');
  const { minX, maxX, minY, maxY } = arena.bounds;
  const k = Math.min((canvas.width - 24) / (maxX - minX), (canvas.height - 24) / (maxY - minY));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, canvas.width / 2 - ((minX + maxX) / 2) * k, canvas.height / 2 - ((minY + maxY) / 2) * k);
  ctx.lineCap = 'round';
  const line = (side, from, to, goal) => {
    ctx.setLineDash(goal ? [8 / k, 8 / k] : []);
    ctx.lineWidth = (goal ? 1.5 : 3) / k;
    ctx.strokeStyle = goal ? 'rgba(244,244,244,0.5)' : '#f4f4f4';
    ctx.beginPath();
    ctx.moveTo(side.a.x + side.t.x * from, side.a.y + side.t.y * from);
    ctx.lineTo(side.a.x + side.t.x * to, side.a.y + side.t.y * to);
    ctx.stroke();
  };
  for (const side of arena.sides) {
    if (side.kind !== 'goal') line(side, 0, side.length, false);
    else if (mode === 'pong') line(side, 0, side.length, true);
    else {
      const { mouth, center, minR } = mode === 'hockey' ? hockeyZone(arena, side.seat) : { ...soccerGoal(side), minR: SOCCER.creaseRadius };
      line(side, 0, mouth.from, false);
      line(side, mouth.from, mouth.to, true);
      line(side, mouth.to, side.length, false);
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = 'rgba(244,244,244,0.5)';
      ctx.beginPath();
      ctx.arc(center.x, center.y, minR, Math.atan2(side.t.y, side.t.x), Math.atan2(-side.t.y, -side.t.x), side.t.x * side.n.y - side.t.y * side.n.x < 0);
      ctx.stroke();
    }
  }
}

createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(createForm);
  const count = Number(data.get('players'));
  clearErrors();
  net.send({
    t: 'create',
    name: data.get('adminName'),
    adminPlays: data.get('adminPlays') === 'on',
    maxPlayers: count,
    lives: Number(data.get('lives')),
    mode: data.get('mode'),
    seats: Array.from({ length: count }, (_, i) => data.get(`seat${i}`) ?? 'open'),
  });
});

// ---- Room lobby ----

function renderRoom() {
  const { room, seat: mySeat, isAdmin } = lobby;
  if (!room) return;
  $('#room-code').textContent = room.code;
  setRoomPath(room.code);
  $('#room-meta').textContent = `${MODE_NAMES[room.mode]} · ${room.seats.length} players · ${room.lives} ${room.lives === 1 ? 'life' : 'lives'}`;
  const list = $('#seat-list');
  list.replaceChildren();
  room.seats.forEach((seat, i) => {
    const li = document.createElement('li');
    li.className = `seat ${seat.kind}${i === mySeat ? ' you' : ''}`;
    const num = document.createElement('span');
    num.className = 'seat-num';
    num.textContent = i + 1;
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = seat.kind === 'open' ? 'Waiting for player…' : seat.name;
    const meta = document.createElement('span');
    meta.className = 'seat-meta';
    const tags = [];
    if (i === mySeat) tags.push('you');
    if (i === room.adminSeat) tags.push('admin');
    if (seat.kind === 'bot') tags.push(`bot · ${seat.difficulty}`);
    meta.textContent = tags.join(' · ');
    li.append(num, name, meta);

    if (isAdmin && i !== room.adminSeat && !room.started) {
      const options = seat.kind === 'human'
        ? [['human', 'Player'], ...SEAT_OPTIONS.map(([v, l]) => [v, v === 'open' ? 'Kick' : l])]
        : SEAT_OPTIONS;
      const select = selectEl(`seat${i}`, seat.kind === 'bot' ? seat.difficulty : seat.kind, options);
      select.addEventListener('change', () => net.send({ t: 'setSeat', seat: i, config: select.value }));
      li.append(select);
    }
    list.append(li);
  });
  const hasOpen = room.seats.some((s) => s.kind === 'open');
  for (const el of document.querySelectorAll('.admin-only')) el.hidden = !isAdmin;
  $('#room-wait').hidden = isAdmin;
  $('#start-game').disabled = hasOpen || room.started;
  $('#fill-bots').disabled = !hasOpen || room.started;
}

$('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomLink(lobby.room.code).href);
    $('#copy-code').textContent = 'Copied';
    setTimeout(() => ($('#copy-code').textContent = 'Copy link'), 1200);
  } catch {
    // Clipboard can be blocked outside secure contexts; the address bar has the link anyway.
  }
});

$('#fill-bots').addEventListener('click', () => net.send({ t: 'fillBots' }));
$('#start-game').addEventListener('click', () => net.send({ t: 'start' }));
$('#leave-room').addEventListener('click', () => net.send({ t: 'leave' }));

// ---- Match ----

function startMatch(seatCount, seat, mode = 'pong') {
  stopMatch();
  const arena = buildArena(seatCount);
  const rotation = viewRotation(arena, seat);
  let input = null;
  let controls = '';
  if (seat !== null && mode !== 'pong') {
    const kick = mode === 'soccer';
    controls = freeControlsLabel(isTouchDevice(), kick);
    input = new FreeInput(
      $('#touch-pad'),
      $('#field'),
      { toWorld: (x, y) => renderer.toWorld(x, y), rotation, kick, onCharge: (start) => (renderer.localCharge = start) },
      (move) => net.send({ t: 'input', ...move }),
    );
  } else if (seat !== null) {
    const tangent = rotate(sideForSeat(arena, seat).t, rotation);
    controls = controlsLabel(tangent, isTouchDevice());
    input = new PaddleInput($('#touch-pad'), () => tangent, (dir) => net.send({ t: 'input', dir }));
  }
  renderer.setMatch(arena, { mode, youSeat: seat, rotation, controls });
  match = { buffer: new SnapshotBuffer(), input, snap: null, paused: false, menu: false, overAt: null, overlay: null, last: performance.now(), raf: 0 };
  hideOverlay();
  show('game');
  if (isTouchDevice()) lockLandscape();
  updateOrientation();
  renderer.resize();
  match.raf = requestAnimationFrame(frame);
}

function frame(now) {
  if (!match) return;
  const dt = Math.min(0.1, (now - match.last) / 1000);
  match.last = now;
  match.input?.flush?.();
  const { snap, events } = match.buffer.sample(now, dt);
  if (snap) {
    renderer.queue(events);
    renderer.draw(snap, match.paused ? 0 : dt);
    match.snap = snap;
    if (snap.phase === 'over' && match.overAt === null) match.overAt = now;
  }
  syncOverlay(now);
  if (debug) {
    trackGap(debug.frames, now);
    debug.el.textContent = `frame gap ${maxGap(debug.frames)} ms\nserver gap ${maxGap(debug.states)} ms\nbuffer ${Math.round(match.buffer.delay)} ms\nresizes ${debug.resizes}`;
  }
  match.raf = requestAnimationFrame(frame);
}

function stopMatch() {
  if (!match) return;
  cancelAnimationFrame(match.raf);
  match.input?.detach();
  match = null;
  hideOverlay();
}

// Picks which overlay (if any) the match needs and rebuilds it only on change.
function syncOverlay(now) {
  const over = match.overAt !== null && now - match.overAt > OVER_DELAY_MS;
  let key = '';
  if (over) key = 'over';
  else if (match.paused) key = 'paused';
  else if (match.menu) key = 'menu';
  if (key === match.overlay) return;
  match.overlay = key;

  const { isAdmin } = lobby;
  const leave = ['Leave room', () => net.send({ t: 'leave' })];
  if (key === 'over') {
    const winner = match.snap.players[match.snap.winner];
    showOverlay(winner ? `${winner.name} wins` : 'Game over', isAdmin ? '' : 'Waiting for the admin…', isAdmin
      ? [['Rematch', () => net.send({ t: 'start' }), true], ['Back to room', () => net.send({ t: 'end' })]]
      : [leave]);
  } else if (key === 'paused') {
    showOverlay('Paused', isAdmin ? 'Esc to resume' : 'The admin paused the game', isAdmin
      ? [['Resume', () => net.send({ t: 'pause' }), true], ['End match', () => net.send({ t: 'end' })]]
      : [leave]);
  } else if (key === 'menu') {
    showOverlay('Menu', 'The game keeps running', [['Back to game', () => (match.menu = false), true], leave]);
  } else {
    hideOverlay();
  }
}

// The admin's menu pauses the game for everyone; other players get a local menu.
function openMenu() {
  if (!match || match.overAt !== null) return;
  if (lobby.isAdmin) net.send({ t: 'pause' });
  else match.menu = !match.menu;
}

function showOverlay(title, subtitle, buttons) {
  $('#overlay-title').textContent = title;
  $('#overlay-sub').textContent = subtitle;
  const row = $('#overlay-actions');
  row.replaceChildren();
  for (const [label, onClick, primary] of buttons) {
    const btn = document.createElement('button');
    btn.className = primary ? 'btn primary' : 'btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    row.append(btn);
  }
  $('#overlay').hidden = false;
  row.querySelector('button')?.focus();
}

function hideOverlay() {
  $('#overlay').hidden = true;
}

$('#pause').addEventListener('click', openMenu);
addEventListener('keydown', (e) => {
  if (e.code === 'Escape') openMenu();
});

// Mobile toolbars fire a burst of resize events while they animate; handle at
// most one per frame.
let resizeQueued = false;
addEventListener('resize', () => {
  if (debug) debug.resizes++;
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    updateOrientation();
    renderer.resize();
  });
});

// Android: the first touch in a game (a user gesture, as fullscreen requires)
// hides the browser bars for good. iPhone browsers don't support this.
$('#touch-pad').addEventListener('pointerdown', () => {
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  if (document.fullscreenElement || standalone || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(lockLandscape, () => {});
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

renderSeatConfig();
