import { RoomManager, RoomError, roomView } from '../shared/rooms.js';
import { Game } from '../shared/sim.js';
import { Bot } from '../shared/bot.js';

const TICK = 1 / 120;
const MAX_ROOMS = 500;

// Message protocol. Every message is JSON with its type in `t`.
//
// client → server
//   create  { name, adminPlays, maxPlayers, lives, seats }   needs a logged-in admin
//   join    { code, name }
//   leave   {}
//   setSeat { seat, config }   admin: 'open' (kick) or a bot level
//   fillBots {}                admin
//   start   {}                 admin: start, or rematch once a game is over
//   end     {}                 admin: stop the match, everyone back to the room
//   pause   {}                 admin: toggle pause
//   input   { dir }            -1, 0 or 1 along your side
//
// server → client
//   hello  { user, loginRequired }   user: the logged-in admin's name or null
//   room   { room, seat, isAdmin }   seat is null for an admin who only watches
//   start  { seatCount, seat }
//   state  { ts, s, e, paused }      server send time (ms), snapshot, events since the last state
//   end    {}
//   left   {}
//   closed { reason }
//   error  { message }

// Trims floats so state messages stay small.
const roundNumbers = (key, value) => (typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 100) / 100 : value);

class Match {
  constructor(seats, lives) {
    this.game = new Game({ seats, lives });
    this.bots = new Map(seats.flatMap((s, i) => (s.isBot ? [[i, new Bot(i, s.difficulty)]] : [])));
    this.acc = 0;
    this.paused = false;
    this.events = [];
    this.finished = false;
  }

  // A player who drops out mid-game is played by a bot from then on.
  takeOver(seat) {
    this.bots.set(seat, new Bot(seat, 'medium'));
    const player = this.game.players[seat];
    player.isBot = true;
    player.difficulty = 'medium';
  }

  step(dt) {
    if (this.paused) return;
    this.acc += dt;
    while (this.acc >= TICK) {
      for (const bot of this.bots.values()) this.game.setInput(bot.seat, bot.update(this.game, TICK));
      this.game.step(TICK);
      this.events.push(...this.game.drainEvents());
      this.acc -= TICK;
    }
  }
}

// Connects clients to rooms and runs one authoritative match per room. A
// client is any object with send(message), plus `user` when it belongs to a
// logged-in admin; messages may be objects or pre-serialised strings.
// Transport and login live in server/app.js.
export class Lobby {
  constructor({ loginRequired = false } = {}) {
    this.loginRequired = loginRequired;
    this.rooms = new RoomManager();
    this.members = new Map(); // room code → Set of clients
    this.matches = new Map(); // room code → Match
  }

  connect(client) {
    client.code = null;
    client.playerId = null;
    client.user ??= null;
    client.send({ t: 'hello', user: client.user, loginRequired: this.loginRequired });
  }

  disconnect(client) {
    this.#leave(client);
  }

  message(client, msg) {
    try {
      this.#handle(client, msg);
    } catch (err) {
      if (!(err instanceof RoomError)) console.error(err);
      client.send({ t: 'error', message: err instanceof RoomError ? err.message : 'Something went wrong.' });
    }
  }

  // Advances every running match by dt seconds and sends out the new state.
  tick(dt) {
    for (const [code, match] of this.matches) {
      if (match.finished) continue;
      match.step(dt);
      const payload = JSON.stringify({ t: 'state', ts: performance.now(), s: match.game.snapshot(), e: match.events, paused: match.paused }, roundNumbers);
      match.events = [];
      for (const client of this.members.get(code) ?? []) client.send(payload);
      if (match.game.phase === 'over') match.finished = true;
    }
  }

  #handle(client, msg) {
    switch (msg?.t) {
      case 'create': {
        if (this.loginRequired && !client.user) throw new RoomError('forbidden', 'Log in as an admin to create rooms.');
        if (this.rooms.size >= MAX_ROOMS) throw new RoomError('busy', 'The server is full. Try again later.');
        const { room, playerId } = this.rooms.createRoom({
          adminName: msg.name || client.user,
          adminPlays: msg.adminPlays !== false,
          maxPlayers: Number(msg.maxPlayers),
          lives: msg.lives,
          seats: Array.isArray(msg.seats) ? msg.seats.map(String) : [],
        });
        this.#leave(client);
        this.#enter(client, room.code, playerId);
        return;
      }
      case 'join': {
        const { room, playerId } = this.rooms.join(msg.code, msg.name);
        this.#leave(client);
        this.#enter(client, room.code, playerId);
        return;
      }
      case 'leave':
        this.#leave(client);
        client.send({ t: 'left' });
        return;
      case 'setSeat':
        this.rooms.setSeat(client.code, client.playerId, Number(msg.seat), String(msg.config));
        this.#broadcastRoom(client.code);
        return;
      case 'fillBots':
        this.rooms.fillWithBots(client.code, client.playerId);
        this.#broadcastRoom(client.code);
        return;
      case 'start':
        this.#start(client);
        return;
      case 'end':
        this.#endMatch(this.#adminRoom(client).code);
        return;
      case 'pause': {
        const match = this.matches.get(this.#adminRoom(client).code);
        if (match && !match.finished) match.paused = !match.paused;
        return;
      }
      case 'input': {
        const match = this.matches.get(client.code);
        const seat = this.#seatOf(client);
        if (match && seat !== null && !match.bots.has(seat)) match.game.setInput(seat, Number(msg.dir) || 0);
        return;
      }
      default:
        throw new RoomError('bad-request', 'Unknown message.');
    }
  }

  #start(client) {
    const room = this.#adminRoom(client);
    const running = this.matches.get(room.code);
    if (running && !running.finished) throw new RoomError('started', 'A game is already running.');
    if (running) this.rooms.finish(room.code); // rematch
    const seats = this.rooms.start(room.code, client.playerId);
    this.matches.set(room.code, new Match(seats, room.lives));
    for (const c of this.members.get(room.code)) c.send({ t: 'start', seatCount: seats.length, seat: this.#seatOf(c) });
    this.#broadcastRoom(room.code);
  }

  #endMatch(code) {
    if (!this.matches.delete(code)) return;
    this.rooms.finish(code);
    for (const c of this.members.get(code) ?? []) c.send({ t: 'end' });
    this.#broadcastRoom(code);
  }

  #enter(client, code, playerId) {
    client.code = code;
    client.playerId = playerId;
    if (!this.members.has(code)) this.members.set(code, new Set());
    this.members.get(code).add(client);
    this.#broadcastRoom(code);
  }

  #leave(client) {
    const { code, playerId } = client;
    if (!code) return;
    client.code = null;
    client.playerId = null;
    const others = this.members.get(code);
    others?.delete(client);
    const { seat, closed } = this.rooms.leave(code, playerId);
    if (closed) {
      this.matches.delete(code);
      this.members.delete(code);
      for (const c of others ?? []) {
        c.code = null;
        c.playerId = null;
        c.send({ t: 'closed', reason: 'The room closed because everyone left.' });
      }
      return;
    }
    const match = this.matches.get(code);
    if (match && seat !== null) match.takeOver(seat);
    this.#broadcastRoom(code);
  }

  #adminRoom(client) {
    const room = this.rooms.get(client.code);
    if (room.adminId !== client.playerId) throw new RoomError('forbidden', 'Only the room admin can do that.');
    return room;
  }

  #seatOf(client) {
    if (!client.code) return null;
    const seat = this.rooms.get(client.code).seats.findIndex((s) => s.id === client.playerId);
    return seat === -1 ? null : seat;
  }

  #broadcastRoom(code) {
    const room = this.rooms.get(code);
    const view = roomView(room);
    for (const c of this.members.get(code) ?? []) {
      c.send({ t: 'room', room: view, seat: this.#seatOf(c), isAdmin: room.adminId === c.playerId });
    }
  }
}
