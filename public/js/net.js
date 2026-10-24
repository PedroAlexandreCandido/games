// WebSocket link to the game server. Reconnects automatically; listeners get
// 'up' and 'down' when the link changes, plus one event per message type.
export class Connection {
  constructor() {
    this.handlers = new Map();
    this.connected = false;
    this.#open();
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  send(message) {
    if (!this.connected) {
      this.#emit('error', { message: 'Not connected to the server yet.' });
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  // Opens a fresh connection right away, e.g. to pick up a new session cookie.
  reconnect() {
    this.quiet = true;
    this.ws.close();
  }

  #emit(type, message) {
    this.handlers.get(type)?.(message);
  }

  #open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.#emit('up');
    };
    ws.onmessage = (e) => {
      const message = JSON.parse(e.data);
      this.#emit(message.t, message);
    };
    ws.onclose = () => {
      if (this.connected && !this.quiet) this.#emit('down');
      this.connected = false;
      setTimeout(() => this.#open(), this.quiet ? 0 : 1000);
      this.quiet = false;
    };
  }
}
