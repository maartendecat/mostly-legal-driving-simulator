import { DEFAULT_SERVER_PORT } from '@game/shared';
import { GameServer } from './GameServer';

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
const seed = Number(process.env.SEED ?? 1234);

const server = new GameServer({ port, seed });
await server.listening();
console.log(`Game server listening on ws://localhost:${server.port} (city seed ${seed})`);

setInterval(() => {
  if (server.playerCount > 0) console.log(`tick ${server.world.tick} · ${server.playerCount} player(s)`);
}, 10_000);
