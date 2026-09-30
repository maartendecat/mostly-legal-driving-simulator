import {
  CAR_MODELS,
  DEFAULT_SERVER_PORT,
  PED_MAX_HEALTH,
  PICKUP_RADIUS,
  TICK_RATE,
  WEAPONS,
  canPickUpWeapons,
  carSpeed,
  isDead,
  isPickupAvailable,
  type GameEvent,
  type Ped,
  type PlayerInfo,
} from '@game/shared';
import type { AssetPack } from './assets/AssetPack';
import { KenneyPack } from './assets/kenney/KenneyPack';
import { PlaceholderPack } from './assets/placeholder/PlaceholderPack';
import { Keyboard } from './input/Keyboard';
import { GameRenderer } from './render/GameRenderer';
import type { Transform, TransformSnapshot } from './render/transforms';
import type { GameSession } from './session/GameSession';
import { LocalSession } from './session/LocalSession';
import { NetworkSession } from './session/NetworkSession';
import { describeOwnDeath } from './ui/deathText';
import { showLobbyScreen } from './ui/LobbyScreen';
import { KillFeed } from './ui/KillFeed';
import { NameTags, type NameTag } from './ui/NameTags';
import { PlayerArrows, type PlayerArrow } from './ui/PlayerArrows';
import { Scoreboard } from './ui/Scoreboard';
import { Toast } from './ui/Toast';

/** Height above the ground at which name tags float, in blocks. */
const NAME_TAG_HEIGHT = 0.9;

/**
 * URL options:
 *   ?offline           play single-player without a server
 *   ?server=ws://...   game server to connect to (default: same host, port 8080)
 *   ?seed=42           city seed for offline play
 *   ?lag=150           simulate this much round-trip network delay, in ms (for testing)
 *   ?pack=placeholder  use the plain placeholder shapes instead of the Kenney art
 */
async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const session = await startSession(params);

  const pack = await loadPack(params.get('pack'));
  const renderer = new GameRenderer(document.getElementById('game')!, pack);
  renderer.setMap(session.world.map);
  const nameTags = new NameTags(document.getElementById('tags')!);
  const arrows = new PlayerArrows(document.getElementById('arrows')!);
  const hud = document.getElementById('hud')!;
  const wasted = new WastedScreen();
  const killFeed = new KillFeed(document.getElementById('killfeed')!);
  const scoreboard = new Scoreboard(document.getElementById('match-status')!, document.getElementById('scoreboard')!);
  // Hold Tab for the scoreboard (and keep Tab from moving focus around the page).
  const toggleScoreboard = (event: KeyboardEvent, held: boolean) => {
    if (event.code !== 'Tab') return;
    event.preventDefault();
    scoreboard.held = held;
  };
  window.addEventListener('keydown', (e) => toggleScoreboard(e, true));
  window.addEventListener('keyup', (e) => toggleScoreboard(e, false));
  window.addEventListener('blur', () => (scoreboard.held = false));
  // Esc leaves the game and goes back to the lobby (dropping the room from the address).
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Escape') return;
    if (session instanceof NetworkSession) session.close();
    location.href = location.pathname + location.search;
  });
  // The address bar becomes an invite link: anyone opening it joins this room.
  if (session instanceof NetworkSession) history.replaceState(null, '', `${location.pathname}${location.search}#room=${session.roomId}`);
  let lastIt: number | null = null;
  const toast = new Toast(document.getElementById('toast')!);
  let blockedPickupId: number | null = null;

  // Handy for debugging from the browser console; stripped from production builds.
  if (import.meta.env.DEV) Object.assign(window, { game: session });

  const keyboard = new Keyboard();
  let last = performance.now();
  let fps = 60;

  const frame = (now: number) => {
    // Clamp long frames (e.g. background tab) so we don't simulate a huge backlog at once.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const { transforms, events } = session.update(frameDt, () => keyboard.sample());
    renderer.render(session.world, transforms, session.myPedId, frameDt, events);
    wasted.update(session, events);
    for (const event of events) if (event.type === 'death') killFeed.add(session, event);
    const it = session.match?.mode === 'tag' ? session.world.itPedId : null;
    if (it !== null && it !== lastIt) killFeed.addNewIt(session, it);
    lastIt = it;
    blockedPickupId = explainBlockedPickup(session, toast, blockedPickupId);
    scoreboard.update(session);
    const others = otherPlayers(session, transforms);
    nameTags.update(nameTagsFor(others, renderer, session.world.itPedId));
    updateArrows(arrows, session, others, transforms, renderer);

    if (frameDt > 0) fps += (1 / frameDt - fps) * 0.05;
    hud.textContent = hudText(session, fps, pack);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The Kenney art by default; the placeholder shapes on request, or if the art fails to load. */
async function loadPack(requested: string | null): Promise<AssetPack> {
  if (requested !== 'placeholder') {
    const kenney = new KenneyPack();
    try {
      await kenney.load();
      return kenney;
    } catch (error) {
      console.warn('Could not load the Kenney art; using placeholder shapes.', error);
    }
  }
  const placeholder = new PlaceholderPack();
  await placeholder.load();
  return placeholder;
}

/**
 * In development the game server runs next to Vite on its own port; a deployed game is served by
 * the game server itself, so it connects back to the same address (wss:// on https).
 */
function defaultServerUrl(): string {
  if (import.meta.env.DEV) return `ws://${location.hostname}:${DEFAULT_SERVER_PORT}`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

function startSession(params: URLSearchParams): Promise<GameSession> {
  const seed = Number(params.get('seed')) || 1234;
  if (params.has('offline')) return Promise.resolve(new LocalSession(seed));

  const serverUrl = params.get('server') ?? defaultServerUrl();
  const lagMs = Number(params.get('lag')) || 0;
  return showLobbyScreen({ serverUrl, lagMs, playOffline: () => new LocalSession(seed) });
}

/**
 * Tells the player why walking over a crate does nothing (in tag, "it" can't take weapons). Shown
 * once per crate you step on. Returns the crate you're standing on, if any.
 */
function explainBlockedPickup(session: GameSession, toast: Toast, lastPickupId: number | null): number | null {
  const { world } = session;
  const me = session.myPedId === null ? undefined : world.peds.get(session.myPedId);
  if (!me || me.carId !== null || isDead(me) || canPickUpWeapons(world, me)) return null;
  const pickup = [...world.pickups.values()].find((p) => isPickupAvailable(world, p) && Math.hypot(p.x - me.x, p.y - me.y) <= PICKUP_RADIUS);
  if (pickup && pickup.id !== lastPickupId) toast.show("You're IT: no weapons for you!");
  return pickup?.id ?? null;
}

interface OtherPlayer {
  player: PlayerInfo;
  ped: Ped;
  /** Where they're drawn: their ped on foot, or the car they're driving. */
  position: Transform;
}

function otherPlayers(session: GameSession, transforms: TransformSnapshot): OtherPlayer[] {
  const result: OtherPlayer[] = [];
  for (const player of session.players) {
    if (player.pedId === session.myPedId) continue;
    const ped = session.world.peds.get(player.pedId);
    if (ped) result.push({ player, ped, position: transforms.get(ped.carId ?? ped.id) ?? ped });
  }
  return result;
}

function nameTagsFor(others: readonly OtherPlayer[], renderer: GameRenderer, itPedId: number | null): NameTag[] {
  const tags: NameTag[] = [];
  for (const { player, position } of others) {
    const screen = renderer.projectToScreen(position.x, position.y, NAME_TAG_HEIGHT);
    const text = player.pedId === itPedId ? `IT · ${player.name}` : player.name;
    if (screen) tags.push({ id: player.pedId, text, ...screen });
  }
  return tags;
}

/**
 * GTA2-style arrows circling our character, pointing at every other living player. In tag, the
 * hunters only get an arrow to "it", and "it" gets none.
 */
function updateArrows(
  arrows: PlayerArrows,
  session: GameSession,
  others: readonly OtherPlayer[],
  transforms: TransformSnapshot,
  renderer: GameRenderer,
): void {
  const me = session.myPedId === null ? undefined : session.world.peds.get(session.myPedId);
  if (!me) return arrows.update([], 0, 0);
  const myPosition = transforms.get(me.carId ?? me.id) ?? me;
  const { width, height } = renderer.viewportSize();
  const origin = renderer.projectToScreen(myPosition.x, myPosition.y, 0) ?? { x: width / 2, y: height / 2 };

  const itPedId = session.match?.mode === 'tag' ? session.world.itPedId : null;
  const list: PlayerArrow[] = [];
  for (const { player, ped, position } of others) {
    if (isDead(ped)) continue;
    if (itPedId !== null && (me.id === itPedId || ped.id !== itPedId)) continue;
    list.push({
      id: player.pedId,
      name: player.name,
      color: ped.color,
      // The camera looks straight down with north up, so world +y is screen -y.
      dx: position.x - myPosition.x,
      dy: -(position.y - myPosition.y),
    });
  }
  arrows.update(list, origin.x, origin.y);
}

function hudText(session: GameSession, fps: number, pack: AssetPack): string {
  const world = session.world;
  const ped = session.myPedId === null ? undefined : world.peds.get(session.myPedId);
  const car = ped?.carId != null ? world.cars.get(ped.carId) : undefined;
  const status = car ? `Driving: ${CAR_MODELS[car.model].name}  ${Math.round(carSpeed(car) * 10)} km/h` : 'On foot';
  const health = ped ? Math.ceil(ped.health) : 0;
  const bars = Math.ceil((health / PED_MAX_HEALTH) * 10);
  const healthLine = `Health: ${'█'.repeat(bars)}${'░'.repeat(10 - bars)} ${health}`;
  const unarmed = ped && !canPickUpWeapons(world, ped) ? "Unarmed (you're IT: no weapons)" : 'Unarmed (walk over a spinning crate)';
  const weapon = ped?.weapon ? `Weapon: ${WEAPONS[ped.weapon].name} · ${ped.ammo[ped.weapon] ?? 0}` : unarmed;
  const me = session.players.find((p) => p.pedId === session.myPedId);
  const others = session.players.filter((p) => p !== me).map((p) => p.name);
  return [
    healthLine,
    status,
    weapon,
    '',
    'Arrows/WASD  move / steer',
    'Enter or F   get in / out of car',
    'Space        handbrake',
    'J or Ctrl    fire',
    'Z / X        switch weapon',
    session.match ? 'Tab          scores' : '',
    'Esc          leave',
    '',
    me && session instanceof NetworkSession ? `You are ${me.name}` : '',
    others.length > 0 ? `Also here: ${others.join(', ')}` : '',
    session.status,
    `${Math.round(fps)} fps · tick ${world.tick} · assets: ${pack.name}`,
  ]
    .filter((line, i, lines) => line !== '' || lines[i - 1] !== '')
    .join('\n');
}

/** The big red "WASTED" overlay, with who did it and a respawn countdown. */
class WastedScreen {
  private readonly element = document.getElementById('wasted')!;
  private readonly cause = document.getElementById('wasted-cause')!;
  private readonly countdown = document.getElementById('wasted-countdown')!;

  update(session: GameSession, events: readonly GameEvent[]): void {
    const me = session.myPedId;
    for (const event of events) {
      if (event.type === 'death' && event.pedId === me) this.cause.textContent = describeOwnDeath(session, event);
    }
    const ped = me === null ? undefined : session.world.peds.get(me);
    const respawnAt = ped?.respawnAt ?? null;
    this.element.hidden = respawnAt === null;
    if (respawnAt !== null) {
      const seconds = Math.max(1, Math.ceil((respawnAt - session.world.tick) / TICK_RATE));
      this.countdown.textContent = `Back in ${seconds}...`;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  document.getElementById('hud')!.textContent = `Failed to start: ${String(error)}`;
});
