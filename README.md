# Mostly Legal Driving Simulator

A browser-based, online-multiplayer game in the spirit of GTA2's multiplayer: top-down city, cars,
guns, Frag/Points/Tag modes, and arrows pointing at the other players.

How it works and why (architecture, rules and numbers, networking, traffic, decisions):
[docs/DESIGN.md](docs/DESIGN.md).

## Getting started

Requires Node.js 20+.

```bash
npm install
npm run server     # game server on ws://localhost:8080
npm run dev        # client at http://localhost:5173 (in a second terminal)
npm test           # simulation and server tests
npm run typecheck
```

Open http://localhost:5173, pick a name and join a room from the lobby, or create your own (name,
mode, time limit). Every room is its own game with its own city. The server always has one
permanent room; rooms players create close a minute after the last player leaves (max 8 players
per room, 20 rooms). Press Esc in a game to go back to the lobby. *Play offline* runs single-player
without a server. URL options:
`?offline` to force single-player, `?server=ws://host:port` to pick a server, `?lag=200` to
simulate a slow connection.

Controls: arrows/WASD to move or steer, Enter/F to get in or out of a car, Space for the handbrake,
J or Ctrl to fire, Z/X to switch weapons. Weapons lie around the city as spinning crates: grey is a
pistol, blue a machine gun, red a rocket launcher.

You have 100 health. Bullets, rocket blasts and being run over hurt; at zero you're WASTED and
respawn 3 seconds later, unarmed. Cars take damage from gunfire and hard crashes, start smoking,
then burn and explode (get out in time!) and leave a wreck that's replaced after 30 seconds.

The city has traffic and pedestrians (per room, by default 16 cars, 40 people, 6 members of each
of three gangs and 6 cops; `TRAFFIC=30 PEDESTRIANS=60 GANG_MEMBERS=4 COPS=8 npm run server`, or `0`
for none). Traffic drives on the right, turns at
random at intersections, takes turns crossing them, stops for people and cars and drives around
parked ones. Parked cars stand on the kerb. Jump into a traffic car and it's yours. Pedestrians
stroll the pavements, cross the road when it's clear, and run for it when there's shooting or a car
comes at them. Each gang (The Suits, The Lab Rats, The Undead) hangs around its own turf, armed:
hurt one of them and the whole gang is after you for a while. Cops patrol the city.

Online games are matches in one of GTA2's three modes:

- **Frag**: +1 for every kill, −1 for killing yourself. First to 10 frags wins.
- **Points**: 1,000 points per kill, −500 for killing yourself, 100 for every car you wreck,
  10 per pedestrian.
  First to 10,000 wins.
- **Tag**: one player is "it" and can't pick up weapons, can't see arrows, and their car takes
  double damage. Kill "it" to become "it". Time as "it" (alive) counts: first to 2 minutes wins.

If nobody reaches the limit, whoever leads when time runs out wins. Then there's a 10-second break
showing the scores and a new match starts. Hold Tab for the scoreboard. Other players show up as
arrows in their colour circling your character (in Tag, only "it" gets an arrow). Rooms created in
the lobby pick their own mode and time limit; the server's permanent room is configured with
environment variables:

```bash
MODE=points npm run server          # frag (default), points, tag, or rotate (all three in turn)
MODE=tag SCORE_LIMIT=90 TIME_LIMIT=5 npm run server   # 90 s as "it" to win; 5-minute matches
```

`SCORE_LIMIT` is in frags, points or seconds as "it"; 0 means no limit, as does `TIME_LIMIT=0`.
Add `?seed=42` to the URL for a different city.

## Hosting

The game server also serves the game page, so a deployed game is one process on one port:

```bash
npm start              # builds the client, then serves game + server on http://localhost:8080
```

Any host that runs a Docker container and allows WebSockets works (Fly.io, Render, Railway, a
VPS). The platform's HTTPS turns into `wss://` automatically; the page connects back to the same
address it was loaded from.

```bash
docker build -t mostly-legal .
docker run -p 8080:8080 -e MODE=rotate mostly-legal
```

With Fly.io, for example: `fly launch` (it finds the Dockerfile; internal port 8080), then
`fly deploy`. Pick a region close to your players. Things to know:

- Rooms live in the server's memory: run exactly **one** instance, and a restart ends all games.
- `GET /healthz` returns `{ ok, rooms, players }` for health checks.
- The same environment variables apply (`MODE`, `SCORE_LIMIT`, `TIME_LIMIT`, `TRAFFIC`,
  `PEDESTRIANS`, `GANG_MEMBERS`, `COPS`, `SEED`, `PORT`).
- After joining a room, the address bar is an invite link (`…/#room=abc123`): send it to friends
  and they land in the same room.

### Deploying to Railway

About $5 a month on Railway's Hobby plan (which includes $5 of usage; this server should fit in
it). New accounts get a one-time $5 trial to try it first. `railway.json` in this repo already
tells Railway to build the Dockerfile and to use `/healthz` as the health check.

1. Put the repo on GitHub:
   ```bash
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin main
   ```
2. On [railway.com](https://railway.com), sign in with GitHub, then **New Project → Deploy from
   GitHub repo** and pick the repo. Railway builds and starts the server.
3. In the service's **Variables**, add `PORT` = `8080` (plus `MODE`, `TIME_LIMIT` etc. if you
   like; see above).
4. In **Settings → Networking → Public Networking**, click **Generate Domain** and use port
   `8080`. You get an address like `https://<name>.up.railway.app`: that's the game. Share it,
   or join a room and share the invite link.
5. Keep it at **one replica**: rooms live in memory. Every push to `main` redeploys, which ends
   the games in progress.

## Layout

```
packages/
  shared/   Game simulation: map, car physics, peds, rules. No DOM, no rendering, no networking.
            Runs identically on the server (authoritative) and in the browser (prediction).
  client/   Browser client: Vite + Three.js renderer, input, asset packs.
  server/   Node.js authoritative server (WebSockets): a lobby plus any number of game rooms.
            Clients send only their input; each room runs its world and sends every player
            what changed around them, 30 times per second.
docs/       DESIGN.md: the design in detail
```

Online, the client predicts its own movement: it applies each input locally straight away and sends
it to the server with a sequence number. Snapshots report the last input the server applied; the
client resets to the server's state and replays the rest, which corrects any misprediction.
Other players are drawn 100 ms in the past, blended between buffered snapshots, so they move
smoothly even when snapshots arrive late or get lost.

The simulation runs at a fixed 60 ticks per second. The client interpolates between ticks
when rendering, so it looks smooth at any frame rate.

## Asset packs

The game never touches graphics directly. It goes through the `AssetPack` interface
(`packages/client/src/assets/AssetPack.ts`):

| Pack | Status | Use |
|---|---|---|
| `KenneyPack` | ✅ default | Free CC0 art by [Kenney](https://kenney.nl): 3D cars (Car Kit), people, ground tiles, crates and bushes (Top-down Shooter); building facades drawn in code. Files in `packages/client/public/assets/kenney/`. |
| `PlaceholderPack` | ✅ done | Coloured boxes. Needs no files; good for gameplay work. Use `?pack=placeholder`. |
| Classic pack | planned | Converted in the browser from the player's **own** GTA2 `.sty`/`.gmp` files. Cached in IndexedDB, never uploaded or distributed. |

Gameplay data (car sizes and speeds, collision, map layout) lives in `@game/shared`, not in asset
packs, so the server can simulate without loading any graphics.

**Never commit or host original GTA2 files.** Rockstar still owns the copyright on the art, sound,
maps and name. `.sty` and `.gmp` files are gitignored.

## Roadmap

1. ✅ Shared simulation, placeholder renderer, driving and walking offline
2. ✅ Multiplayer: authoritative WebSocket server, client-side prediction with reconciliation,
   snapshot interpolation for other players, join screen with player names
3. Combat: ✅ 3a weapons (pistol, machine gun, rocket launcher) and pickups; ✅ 3b health,
   damage, death and respawning, exploding cars; ✅ 3c Frag mode with kill feed and
   scoreboard; ✅ 3d player arrows; ✅ 3e Points and Tag modes
4. (optional) Car handling: mass, speed-dependent steering
5. ✅ 5a Lobby and game rooms (map editor: later)
6. Graphics: ✅ 6a Kenney CC0 art pack (classic GTA2-files pack: later)
7. ✅ Online play over the internet: delta snapshots (about 5–20 kB/s per player instead of
   245 kB/s), smooth prediction corrections, remote bullets no longer vanish early; one-process
   hosting with a Dockerfile, health check and invite links. Not yet: WebRTC/WebTransport and
   lag compensation for hits (revisit after playtesting over the internet)

### Part A: a living city (in progress)

1. ✅ More kinds of people: gangs, cops, and more variety among pedestrians
2. Pedestrians reacting to bodies
3. Traffic drivers stepping out when a player takes their car
4. Fire trucks that come when fire breaks out (exploding cars)
5. Police as a game option: first an analysis of how they should behave (minor crimes only when a
   police car sees it, major crimes a proactive response, eventually the army with tanks and
   helicopters), then the implementation

### Later

- ✅ Walking animation for people, like GTA2's (feet stepping out, body swaying)
- A livelier city: ✅ traffic, ✅ pedestrians (more in Part A above)
- Points popping up where they're earned, like GTA2 (a car exploding, damage done, kills)
- In-browser map editor (started, then postponed; unfinished work in `git stash`)
- Classic pack: load your own GTA2 files in the browser
