# Mostly Legal Driving Simulator

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

Open http://localhost:5173 in several tabs or browsers, pick a name and press *Play online* to get
several players in the same city. *Play offline* runs single-player without a server. URL options:
`?offline` to force single-player, `?server=ws://host:port` to pick a server, `?lag=200` to
simulate a slow connection.

Controls: arrows/WASD to move or steer, Enter/F to get in or out of a car, Space for the handbrake,
J or Ctrl to fire, Z/X to switch weapons. Weapons lie around the city as spinning crates: grey is a
pistol, blue a machine gun, red a rocket launcher.

You have 100 health. Bullets, rocket blasts and being run over hurt; at zero you're WASTED and
respawn 3 seconds later, unarmed. Cars take damage from gunfire and hard crashes, start smoking,
then burn and explode (get out in time!) and leave a wreck that's replaced after 30 seconds.

Online games are **Frag** matches, as in GTA2: +1 for every kill, −1 for killing yourself. First to
10 frags wins, or whoever leads after 10 minutes; then there's a 10-second break showing the scores
and a new match starts. Hold Tab for the scoreboard. Change the limits when starting the server:
`FRAG_LIMIT=20 TIME_LIMIT=15 npm run server` (0 means no limit).
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
Other players are drawn 100 ms in the past, blended between buffered snapshots, so they move
smoothly even when snapshots arrive late or get lost.

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
2. ✅ Multiplayer: authoritative WebSocket server, client-side prediction with reconciliation,
   snapshot interpolation for other players, join screen with player names
3. Combat: ✅ 3a weapons (pistol, machine gun, rocket launcher) and pickups; ✅ 3b health,
   damage, death and respawning, exploding cars; ✅ 3c Frag mode with kill feed and
   scoreboard; next player arrows (3d), Points and Tag modes (3e)
4. Lobbies and matchmaking; map editor
5. Open asset pack, then the classic pack importer
6. Netcode tuning: WebRTC/WebTransport, delta compression, lag compensation
