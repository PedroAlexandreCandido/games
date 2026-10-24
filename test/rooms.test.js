import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../shared/rooms.js';

const errorCode = (code) => (err) => err.code === code;

test('admin creates a room with a readable 5-character code', () => {
  const rooms = new RoomManager();
  const { room, playerId } = rooms.createRoom({ adminName: 'Ana', maxPlayers: 3, seats: ['open', 'hard', 'open'] });
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(room.adminId, playerId);
  assert.deepEqual(room.seats.map((s) => s.kind), ['human', 'bot', 'open']);
  assert.equal(rooms.get(room.code.toLowerCase()), room);
});

test('players join with the code until the room is full', () => {
  const rooms = new RoomManager();
  const { room } = rooms.createRoom({ adminName: 'Ana', maxPlayers: 3, seats: ['open', 'open', 'easy'] });
  const { seat } = rooms.join(` ${room.code.toLowerCase()} `, 'Bo');
  assert.equal(seat, 1);
  assert.throws(() => rooms.join(room.code, 'Cy'), errorCode('full'));
  assert.throws(() => rooms.join('ZZZZZ', 'Cy'), errorCode('not-found'));
});

test('only the admin manages seats and starts, and only when full', () => {
  const rooms = new RoomManager();
  const { room, playerId: admin } = rooms.createRoom({ adminName: 'Ana', maxPlayers: 4 });
  const { playerId: guest } = rooms.join(room.code, 'Bo');
  assert.throws(() => rooms.start(room.code, admin), errorCode('not-full'));
  assert.throws(() => rooms.fillWithBots(room.code, guest), errorCode('forbidden'));
  assert.throws(() => rooms.setSeat(room.code, admin, 0, 'easy'), errorCode('bad-seat'));

  rooms.setSeat(room.code, admin, 1, 'open'); // kick the guest
  assert.equal(room.seats[1].kind, 'open');
  rooms.fillWithBots(room.code, admin, 'hard');
  const seats = rooms.start(room.code, admin);
  assert.deepEqual(seats.map((s) => s.isBot), [false, true, true, true]);
  assert.throws(() => rooms.join(room.code, 'Late'), errorCode('started'));
});

test('codes stay unique', () => {
  const rooms = new RoomManager();
  const codes = new Set();
  for (let i = 0; i < 500; i++) codes.add(rooms.createRoom({ adminName: 'A' }).room.code);
  assert.equal(codes.size, 500);
});
