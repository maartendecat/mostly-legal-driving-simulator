# GTA2 Online (working title)

A browser-based, online-multiplayer game in the spirit of GTA2's multiplayer: top-down city, cars,
guns, Frag/Points/Tag modes, and arrows pointing at the other players.

## Getting started

Requires Node.js 20+.

```bash
npm install
npm run server     # game server on ws://localhost:8080
npm run dev        # client at http://localhost:5173 (in a second terminal)
npm test           # simulation and server tests
npm run typecheck
```

Open http://localhost:5173 in several tabs or browsers to get several players in the same city.
If no server is running, the client falls back to offline single-player. URL options:
`?offline` to force single-player, `?server=ws://host:port` to pick a server, `?lag=200` to
simulate a slow connection.

Controls: arrows/WASD to move or steer, Enter/F to get in or out of a car, Space for the handbrake.
Add `?seed=42` to the URL for a different city.

## Layout

```
packages/
  shared/   Game simulation: map, car physics, peds, rules. No DOM, no rendering, no networking.
            Runs identically on the server (authoritative) and in the browser (prediction).
  client/   Browser client: Vite + Three.js renderer, input, asset packs.
  server/   Node.js authoritative server (WebSockets). Clients send only their input; the server
            runs the world and broadcasts snapshots 30 times per second.
```

Online, the client predicts its own movement: it applies each input locally straight away and sends
it to the server with a sequence number. Snapshots report the last input the server applied; the
client resets to the server's state and replays the rest, which corrects any misprediction.

The simulation runs at a fixed 60 ticks per second. The client interpolates between ticks
when rendering, so it looks smooth at any frame rate.

## Asset packs

The game never touches graphics directly. It goes through the `AssetPack` interface
(`packages/client/src/assets/AssetPack.ts`):

| Pack | Status | Use |
|---|---|---|
| `PlaceholderPack` | ✅ done | Coloured boxes. Needs no files; good for gameplay work. |
| Open pack | planned | Freely licensed art (e.g. Kenney CC0) and our own maps. Default for public servers. |
| Classic pack | planned | Converted in the browser from the player's **own** GTA2 `.sty`/`.gmp` files. Cached in IndexedDB, never uploaded or distributed. |

Gameplay data (car sizes and speeds, collision, map layout) lives in `@game/shared`, not in asset
packs, so the server can simulate without loading any graphics.

**Never commit or host original GTA2 files.** Rockstar still owns the copyright on the art, sound,
maps and name. `.sty` and `.gmp` files are gitignored.

## Roadmap

1. ✅ Shared simulation, placeholder renderer, driving and walking offline
2. Authoritative server over WebSockets (✅ 2a: server and snapshots; ✅ 2b: client-side
   prediction with server reconciliation), then smooth interpolation of other players plus a
   join screen (2c)
3. Weapons, damage, respawn, Frag mode, player arrows
4. Lobbies and matchmaking; map editor
5. Open asset pack, then the classic pack importer
6. Netcode tuning: WebRTC/WebTransport, delta compression, lag compensation
