import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

test('room links serve the app page; other unknown paths are 404', async () => {
  const { server } = createApp({ admins: [], sessionSecret: 'k' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await (await fetch(`${base}/`)).text();
    const room = await fetch(`${base}/room/AB3CD`);
    assert.equal(room.status, 200);
    assert.match(room.headers.get('content-type'), /text\/html/);
    assert.equal(await room.text(), home);
    assert.equal((await fetch(`${base}/room/AB3CD/`)).status, 200);
    assert.equal((await fetch(`${base}/room/AB3CD/style.css`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});
