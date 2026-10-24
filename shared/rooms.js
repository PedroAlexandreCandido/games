import { BOT_LEVELS } from './bot.js';

// No 0/O or 1/I so codes are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const MAX_NAME = 12;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const openSeat = () => ({ kind: 'open' });
const botSeat = (difficulty, index) => ({ kind: 'bot', difficulty, name: `Bot ${index + 1}` });
const cleanName = (name, fallback) => String(name ?? '').trim().slice(0, MAX_NAME) || fallback;

// What clients may see of a room: no player ids, so nobody can act as someone else.
export function roomView(room) {
  return {
    code: room.code,
    lives: room.lives,
    started: room.started,
    seats: room.seats.map((s) => ({ kind: s.kind, name: s.name ?? null, difficulty: s.difficulty ?? null })),
    adminSeat: room.seats.findIndex((s) => s.id === room.adminId),
  };
}

// In-memory room registry. Runs in the browser for local testing and is meant
// to move to the server unchanged: every mutation names who is acting so the
// server can enforce that only the admin manages seats and starts games.
export class RoomManager {
  constructor({ rng = Math.random } = {}) {
    this.rooms = new Map();
    this.rng = rng;
    this.nextId = 1;
  }

  // seats: one entry per seat, 'open' or a bot level. Seat 0 is ignored when
  // the admin plays, because the admin sits there.
  createRoom({ adminName, adminPlays = true, maxPlayers = 2, lives = 5, seats = [] }) {
    if (![2, 3, 4].includes(maxPlayers)) throw new RoomError('bad-size', 'Rooms hold 2 to 4 players.');
    const adminId = this.#newId();
    const room = {
      code: this.#newCode(),
      adminId,
      lives: Math.min(9, Math.max(1, Math.round(Number(lives)) || 5)),
      started: false,
      seats: Array.from({ length: maxPlayers }, openSeat),
    };
    if (adminPlays) room.seats[0] = { kind: 'human', id: adminId, name: cleanName(adminName, 'Admin') };
    seats.forEach((config, i) => {
      if (i < maxPlayers && room.seats[i].kind === 'open' && Object.hasOwn(BOT_LEVELS, config)) room.seats[i] = botSeat(config, i);
    });
    this.rooms.set(room.code, room);
    return { room, playerId: adminId };
  }

  get(code) {
    const room = this.rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) throw new RoomError('not-found', 'No room with that code.');
    return room;
  }

  join(code, name) {
    const room = this.get(code);
    if (room.started) throw new RoomError('started', 'That game has already started.');
    const seat = room.seats.findIndex((s) => s.kind === 'open');
    if (seat === -1) throw new RoomError('full', 'That room is full.');
    const playerId = this.#newId();
    room.seats[seat] = { kind: 'human', id: playerId, name: cleanName(name, `Player ${seat + 1}`) };
    return { room, seat, playerId };
  }

  // A player leaving mid-game is replaced by a bot under the same name. If the
  // admin leaves, the next human becomes admin; with no humans left the room
  // closes. Returns the freed seat (or null) and whether the room closed.
  leave(code, playerId) {
    const room = this.get(code);
    const seat = room.seats.findIndex((s) => s.id === playerId);
    if (seat !== -1) {
      room.seats[seat] = room.started ? { ...botSeat('medium', seat), name: room.seats[seat].name } : openSeat();
    }
    if (room.adminId === playerId) {
      const heir = room.seats.find((s) => s.kind === 'human');
      if (!heir) {
        this.rooms.delete(room.code);
        return { seat: seat === -1 ? null : seat, closed: true };
      }
      room.adminId = heir.id;
    }
    return { seat: seat === -1 ? null : seat, closed: false };
  }

  // config: 'open' (kicks a human) or a bot level.
  setSeat(code, actorId, seat, config) {
    const room = this.#adminRoom(code, actorId);
    if (room.started) throw new RoomError('started', 'Seats are locked while the game runs.');
    const current = room.seats[seat];
    if (!current) throw new RoomError('bad-seat', 'No such seat.');
    if (current.id === room.adminId) throw new RoomError('bad-seat', 'The admin cannot give up their own seat here.');
    if (config === 'open') room.seats[seat] = openSeat();
    else if (Object.hasOwn(BOT_LEVELS, config)) room.seats[seat] = botSeat(config, seat);
    else throw new RoomError('bad-seat', `Unknown seat type: ${config}`);
  }

  fillWithBots(code, actorId, difficulty = 'medium') {
    const room = this.#adminRoom(code, actorId);
    room.seats.forEach((s, i) => {
      if (s.kind === 'open') room.seats[i] = botSeat(difficulty, i);
    });
  }

  // Locks the room and returns the seat list the game simulation needs.
  start(code, actorId) {
    const room = this.#adminRoom(code, actorId);
    if (room.seats.some((s) => s.kind === 'open')) throw new RoomError('not-full', 'Fill every seat before starting.');
    room.started = true;
    return room.seats.map((s) => ({ name: s.name, isBot: s.kind === 'bot', difficulty: s.difficulty ?? null }));
  }

  finish(code) {
    this.get(code).started = false;
  }

  get size() {
    return this.rooms.size;
  }

  close(code, actorId) {
    const room = this.#adminRoom(code, actorId);
    this.rooms.delete(room.code);
  }

  #adminRoom(code, actorId) {
    const room = this.get(code);
    if (room.adminId !== actorId) throw new RoomError('forbidden', 'Only the room admin can do that.');
    return room;
  }

  #newId() {
    return `p${this.nextId++}`;
  }

  #newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(this.rng() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }
}
