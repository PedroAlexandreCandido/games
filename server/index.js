import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { parseAdmins } from './auth.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const admins = parseAdmins(process.env.ADMIN_USERS);
const sessionSecret = process.env.SESSION_SECRET || null;
const trustProxy = process.env.TRUST_PROXY === '1';

const { server } = createApp({ admins, sessionSecret, trustProxy });

server.listen(PORT, HOST, () => {
  console.log(`Pong server on http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${PORT}`);
      }
    }
  }
  if (admins.size === 0) {
    console.log('No ADMIN_USERS set: anyone can create rooms. Run `npm run hash-password -- <name>` to add an admin.');
  } else {
    console.log(`Admins: ${[...admins.keys()].join(', ')}`);
    if (!sessionSecret) console.log('SESSION_SECRET not set: admins will need to log in again after a restart.');
  }
});
