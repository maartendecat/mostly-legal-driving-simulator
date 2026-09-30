import { DEFAULT_MATCH_SETTINGS, DEFAULT_SERVER_PORT, TICK_RATE, secondsToTicks } from '@game/shared';
import { GameServer } from './GameServer';

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
const seed = Number(process.env.SEED ?? 1234);
// Frag limit (0 = none) and time limit in minutes (0 = none).
const fragLimit = Number(process.env.FRAG_LIMIT ?? DEFAULT_MATCH_SETTINGS.fragLimit);
const minutes = Number(process.env.TIME_LIMIT ?? DEFAULT_MATCH_SETTINGS.timeLimitTicks / TICK_RATE / 60);

const server = new GameServer({ port, seed, match: { fragLimit, timeLimitTicks: secondsToTicks(minutes * 60) } });
await server.listening();
console.log(`Game server listening on ws://localhost:${server.port} (city seed ${seed})`);
console.log(`Frag mode: ${fragLimit > 0 ? `first to ${fragLimit}` : 'no frag limit'}, ${minutes > 0 ? `${minutes} min` : 'no time limit'}`);

setInterval(() => {
  if (server.playerCount > 0) console.log(`tick ${server.world.tick} · ${server.playerCount} player(s)`);
}, 10_000);
