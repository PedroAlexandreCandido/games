# Pong Rooms

Online pong, air hockey and soccer for 2–4 players with room codes, bots and power-ups. The server runs every match itself, and each browser sends only its own paddle input.

## Run

```sh
npm install
npm start      # http://localhost:3000
npm test
```

Requires Node 22+.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind. The default accepts connections from other devices on your network. |
| `ADMIN_USERS` | unset | Admin accounts, as comma-separated `name:hash` entries. When it is unset, anyone can create rooms. |
| `SESSION_SECRET` | random per start | Signs login cookies. Set it to a long random string so admins stay logged in across restarts. |
| `TRUST_PROXY` | unset | Set it to `1` behind a hosting proxy so login rate limits and secure cookies use the real client IP and HTTPS. |

## Admin accounts

Only logged-in admins can create rooms. Players join with a code and never need an account.

```sh
npm run hash-password -- pedro          # prompts for a password, prints pedro:scrypt$…
export ADMIN_USERS='pedro:scrypt$…'     # add more accounts, separated by commas
export SESSION_SECRET="$(openssl rand -hex 32)"
npm start
```

Logins last 7 days. Removing an account from `ADMIN_USERS` ends its sessions on the next restart. After 10 failed logins, that IP is locked out for 15 minutes.

## Hosting

Vercel and other serverless platforms will not work: the game needs a long-running process that keeps WebSocket connections open and steps matches 60 times a second. Use a host that runs a container or a Node process, such as Fly.io, Railway or Render. The included `Dockerfile` works on all three. It sets `TRUST_PROXY=1`, and you set `ADMIN_USERS` and `SESSION_SECRET` as secrets in the host's dashboard. Pick a region close to your players, because each player's ping adds to their input delay. Rooms live in memory, so a restart or redeploy ends every game in progress.

## Playing

1. **Create room**: choose the game (Pong, Air hockey or Soccer), 2, 3 or 4 seats, the number of lives, whether you play or only watch, and whether each other seat is open or a bot (easy, medium or hard).
2. Share the room link (**Copy link**), which looks like `https://your-host/room/ABCDE`. Friends open it, type a name and join. The 5-character code also works on its own.
3. The admin can kick players, swap open seats for bots, or use **Fill with bots**. **Start** unlocks once every seat is filled.

Each player sees the field turned so their own side is nearest them: at the bottom in 3- and 4-player games, and on the left in 2-player games. Your paddle and name are yellow. Steer with A/D or ←/→ when your side is at the bottom, and with W/S or ↑/↓ when it's on the left.

On phones and tablets, the game always plays in landscape. If the phone is held upright, the game screen is drawn sideways, so turn the phone. Hold the left or right half of the screen to steer; on a vertical side, hold the top or bottom half. The yellow arrows light up while you hold them. The menu button opens the menu.

In air hockey, your mallet follows the mouse, or moves with WASD or the arrow keys. On phones, drag a finger and the mallet follows it.

In soccer, you move the same way. Hold Space (or the mouse button, or the KICK button on phones) to charge a kick, and let go to kick the way you're facing. A quick tap is a soft pass; a longer hold is a harder shot. The gauge fills, then empties again if you keep holding. Let go exactly as it fills (the orange end) for a perfect shot.

Esc opens the menu. For the admin, it pauses the game for everyone, with options to resume or end the match. For other players, it opens a menu with an option to leave, and the game keeps running. If a player disconnects mid-game, a medium bot takes over their paddle. If the admin leaves, the next human player becomes admin. A room closes when no humans are left.

## Install as an app

The site is a Progressive Web App:
- **iPhone:** in Safari, tap Share, then Add to Home Screen.
- **Android:** in Chrome, open the ⋮ menu and choose Install app.

The installed app opens full screen. On Android it also locks to landscape; iPhone ignores that setting, so the game screen turns sideways instead. A service worker only lets the app open while offline; playing always needs the server.

## Rules

- **2 players**: classic pong. The top and bottom are walls.
- **3 players**: a triangle with cut corners. The three long sides are goals, and the three short corner sides are walls.
- **4 players**: a square, with a goal on every side.
- **Air hockey** uses the same fields, but each goal is a smaller opening in the middle of its side, and the rest of the side is wall. Your round mallet moves freely within a zone around your goal: no closer than the solid crease line, and no further than the faint dashed line. The puck bounces off mallets, and swinging into it hits it harder. The puck slows slightly as it slides.
- **Soccer** uses the same fields and small goals. Players run anywhere except into a goal's crease. Touch a slow ball to take it; it stays in front of you, the way you're moving, for 2.2 seconds before it runs loose. Bump into someone's ball to tackle them. Fast balls bounce off players instead of being trapped. A perfect shot knocks over whoever it hits, sending them flying back.
- When a ball passes your paddle, you lose a life. At 0 lives you are out, and your side becomes a wall. The last player left wins.
- A power-up appears near the centre every 5–10 seconds. When the ball touches one, the power goes to the player who last hit the ball. On average, 1 in 6 power-ups is negative; a negative one affects every other player.

| Power-up | Effect |
| --- | --- |
| Boost (blue) | Paddle moves 1.6× faster for 10 s |
| Power (orange) | Your shots travel at 2× speed for 10 s |
| Growth (green) | Paddle is 1.5× longer (mallet 1.5× wider) for 10 s |
| Slow (red, negative) | Opponents move at 0.55× speed for 7 s |
| Weak (purple, negative) | Opponents' shots travel at 0.6× speed for 7 s |
| Shrink (pink, negative) | Opponents' paddles and mallets are 0.6× the size for 7 s |

## Layout

- `shared/`: game logic with no DOM, used by both the server and the browser.
  - `sim.js`: authoritative simulation (`setInput` → `step` → `snapshot` / `drainEvents`)
  - `arena.js`: field geometry for 2, 3 and 4 seats
  - `hockey.js`: air hockey goal mouths, mallet zones and tuning
  - `soccer.js`: soccer tuning, the kick gauge and player limits
  - `powerups.js`: power-up definitions and rolls
  - `bot.js`: bot AI
  - `rooms.js`: room codes, seats and admin permissions
- `server/`
  - `index.js`: entry point and environment settings
  - `app.js`: static files, the WebSocket at `/ws`, and the 60 Hz game loop
  - `lobby.js`: message protocol, room membership and running matches. The protocol is documented at the top of this file.
- `public/`: the browser client.
  - `main.js`: screens and server messages
  - `net.js`: WebSocket connection with reconnects
  - `snapshots.js`: smooths movement between server updates
  - `render.js` and `fx.js`: canvas drawing and effects
  - `input.js`: keyboard controls
