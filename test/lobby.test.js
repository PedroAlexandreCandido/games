import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { createApp } from '../server/app.js';

// Records everything the lobby sends, parsing pre-serialised state messages.
function fakeClient() {
  const inbox = [];
  return {
    inbox,
    send: (m) => inbox.push(typeof m === 'string' ? JSON.parse(m) : m),
    last: (t) => inbox.findLast((m) => m.t === t),
  };
}

function connected(lobby) {
  const c = fakeClient();
  lobby.connect(c);
  return c;
}

test('admin creates a room, a friend joins with the code, and both see the seats', () => {
  const lobby = new Lobby();
  const admin = connected(lobby);
  lobby.message(admin, { t: 'create', name: 'Ana', maxPlayers: 3, seats: ['open', 'open', 'hard'] });
  const { room } = admin.last('room');
  assert.equal(admin.last('room').isAdmin, true);

  const friend = connected(lobby);
  lobby.message(friend, { t: 'join', code: room.code, name: 'Bo' });
  assert.deepEqual(friend.last('room'), { t: 'room', room: { ...friend.last('room').room }, seat: 1, isAdmin: false });
  assert.deepEqual(admin.last('room').room.seats.map((s) => s.name), ['Ana', 'Bo', 'Bot 3']);
  assert.equal(JSON.stringify(admin.inbox).includes('"id"'), false, 'player ids never reach clients');
});

test('only the admin can start, and everyone then receives game state', () => {
  const lobby = new Lobby();
  const admin = connected(lobby);
  lobby.message(admin, { t: 'create', name: 'Ana', maxPlayers: 2 });
  const friend = connected(lobby);
  lobby.message(friend, { t: 'join', code: admin.last('room').room.code, name: 'Bo' });

  lobby.message(friend, { t: 'start' });
  assert.match(friend.last('error').message, /admin/);

  lobby.message(admin, { t: 'start' });
  assert.deepEqual(admin.last('start'), { t: 'start', seatCount: 2, seat: 0, mode: 'pong' });
  assert.deepEqual(friend.last('start'), { t: 'start', seatCount: 2, seat: 1, mode: 'pong' });

  lobby.message(friend, { t: 'input', dir: 1 });
  for (let i = 0; i < 30; i++) lobby.tick(1 / 60);
  const state = friend.last('state');
  assert.equal(state.s.players.length, 2);
  assert.equal(state.s.phase, 'countdown');
  const before = admin.inbox.filter((m) => m.t === 'state')[0].s.players[1];
  assert.notEqual(state.s.players[1].y, before.y, 'the friend\'s input moved their paddle');
});

test('a player who drops mid-game is replaced by a bot', () => {
  const lobby = new Lobby();
  const admin = connected(lobby);
  lobby.message(admin, { t: 'create', name: 'Ana', maxPlayers: 2 });
  const friend = connected(lobby);
  lobby.message(friend, { t: 'join', code: admin.last('room').room.code, name: 'Bo' });
  lobby.message(admin, { t: 'start' });
  lobby.disconnect(friend);
  lobby.tick(1 / 60);
  const bo = admin.last('state').s.players[1];
  assert.equal(bo.isBot, true);
  assert.equal(bo.name, 'Bo');
  assert.equal(admin.last('room').room.seats[1].kind, 'bot');
});

test('admin role passes on when the admin leaves, and the room closes when empty', () => {
  const lobby = new Lobby();
  const admin = connected(lobby);
  lobby.message(admin, { t: 'create', name: 'Ana', maxPlayers: 2 });
  const friend = connected(lobby);
  lobby.message(friend, { t: 'join', code: admin.last('room').room.code, name: 'Bo' });

  lobby.message(admin, { t: 'leave' });
  assert.equal(friend.last('room').isAdmin, true);
  lobby.message(friend, { t: 'leave' });
  assert.equal(lobby.rooms.size, 0);
});

test('only logged-in admins create rooms when login is required', () => {
  const lobby = new Lobby({ loginRequired: true });
  const guest = connected(lobby);
  assert.deepEqual(guest.last('hello'), { t: 'hello', user: null, loginRequired: true });
  lobby.message(guest, { t: 'create', name: 'Bo', maxPlayers: 2 });
  assert.match(guest.last('error').message, /Log in/);

  const admin = fakeClient();
  admin.user = 'pedro';
  lobby.connect(admin);
  lobby.message(admin, { t: 'create', name: '', maxPlayers: 2 });
  assert.equal(admin.last('room').room.seats[0].name, 'pedro');

  lobby.message(guest, { t: 'join', code: admin.last('room').room.code, name: 'Bo' });
  assert.equal(guest.last('room').seat, 1, 'joining needs no login');
});

test('real WebSocket clients can create, join and play', async () => {
  const { server } = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/ws`;

  const open = (onMessage) => new Promise((resolve) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      inbox.push(msg);
      onMessage?.(msg);
    };
    ws.onopen = () => resolve({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)) });
  });
  const waitFor = (client, t) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${t} message`)), 2000);
    const check = setInterval(() => {
      const msg = client.inbox.findLast((m) => m.t === t);
      if (msg) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(msg);
      }
    }, 10);
  });

  try {
    const admin = await open();
    admin.send({ t: 'create', name: 'Ana', maxPlayers: 4, seats: ['open', 'open', 'easy', 'hard'] });
    const { room } = await waitFor(admin, 'room');
    const friend = await open();
    friend.send({ t: 'join', code: room.code, name: 'Bo' });
    await waitFor(friend, 'room');
    admin.send({ t: 'start' });
    assert.equal((await waitFor(friend, 'start')).seat, 1);
    const state = await waitFor(friend, 'state');
    assert.equal(state.s.players.length, 4);
    admin.ws.close();
    friend.ws.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('air hockey rooms start hockey matches and take 2D input', () => {
  const lobby = new Lobby();
  const admin = connected(lobby);
  lobby.message(admin, { t: 'create', name: 'Ana', maxPlayers: 2, mode: 'hockey', seats: ['open', 'easy'] });
  assert.equal(admin.last('room').room.mode, 'hockey');
  lobby.message(admin, { t: 'start' });
  assert.equal(admin.last('start').mode, 'hockey');
  const match = lobby.matches.get(admin.last('room').room.code);
  lobby.message(admin, { t: 'input', tx: 0, ty: 0 });
  assert.deepEqual(match.game.players[0].input.target, { x: 0, y: 0 });
  lobby.tick(1 / 30);
  assert.ok(admin.last('state').s.players[0].r > 0);

  lobby.message(admin, { t: 'create', name: 'Ana', maxPlayers: 2, mode: 'tennis' });
  assert.match(admin.last('error').message, /mode/);
});
