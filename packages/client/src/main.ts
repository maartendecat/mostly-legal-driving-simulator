import { CAR_MODELS, DEFAULT_SERVER_PORT, carSpeed, type World } from '@game/shared';
import type { AssetPack } from './assets/AssetPack';
import { PlaceholderPack } from './assets/placeholder/PlaceholderPack';
import { Keyboard } from './input/Keyboard';
import { GameRenderer } from './render/GameRenderer';
import type { GameSession } from './session/GameSession';
import { LocalSession } from './session/LocalSession';
import { NetworkSession } from './session/NetworkSession';

/**
 * URL options:
 *   ?offline           play single-player without a server
 *   ?server=ws://...   game server to connect to (default: same host, port 8080)
 *   ?seed=42           city seed for offline play
 *   ?lag=150           simulate this much round-trip network delay, in ms (for testing)
 */
async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const hud = document.getElementById('hud')!;
  const session = await startSession(params, hud);

  const pack: AssetPack = new PlaceholderPack();
  await pack.load();
  const renderer = new GameRenderer(document.getElementById('game')!, pack);
  renderer.setMap(session.world.map);

  // Handy for debugging from the browser console; stripped from production builds.
  if (import.meta.env.DEV) Object.assign(window, { game: session });

  const keyboard = new Keyboard();
  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    // Clamp long frames (e.g. background tab) so we don't simulate a huge backlog at once.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const { transforms } = session.update(frameDt, () => keyboard.sample());
    renderer.render(session.world, transforms, session.myPedId, frameDt);

    if (frameDt > 0) fps += (1 / frameDt - fps) * 0.05;
    hud.textContent = hudText(session, fps, pack);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function startSession(params: URLSearchParams, hud: HTMLElement): Promise<GameSession> {
  const seed = Number(params.get('seed')) || 1234;
  if (params.has('offline')) return new LocalSession(seed);

  const url = params.get('server') ?? `ws://${location.hostname}:${DEFAULT_SERVER_PORT}`;
  hud.textContent = `Connecting to ${url}...`;
  try {
    return await NetworkSession.connect(url, { lagMs: Number(params.get('lag')) || 0 });
  } catch (error) {
    console.warn(error);
    return new LocalSession(seed, 'Offline (no server found; start one with: npm run server)');
  }
}

function hudText(session: GameSession, fps: number, pack: AssetPack): string {
  const world: World = session.world;
  const ped = session.myPedId === null ? undefined : world.peds.get(session.myPedId);
  const car = ped?.carId != null ? world.cars.get(ped.carId) : undefined;
  const status = car ? `Driving: ${CAR_MODELS[car.model].name}  ${Math.round(carSpeed(car) * 10)} km/h` : 'On foot';
  return [
    status,
    '',
    'Arrows/WASD  move / steer',
    'Enter or F   get in / out of car',
    'Space        handbrake',
    '',
    session.status,
    `${Math.round(fps)} fps · tick ${world.tick} · assets: ${pack.name}`,
  ].join('\n');
}

main().catch((error: unknown) => {
  console.error(error);
  document.getElementById('hud')!.textContent = `Failed to start: ${String(error)}`;
});
