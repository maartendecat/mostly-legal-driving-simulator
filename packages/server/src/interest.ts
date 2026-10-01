import { carSpeed, type GameEvent, type Snapshot, type World } from '@game/shared';

/**
 * Interest management: each player only gets what's around them. The camera zooms out with speed,
 * so the area grows while driving fast. A few things always go to everyone: all players and the
 * cars they drive (for arrows and name tags), pickups (they never change, so they cost nothing
 * after the first snapshot), and players' deaths and wrecked cars (for the kill feed and scoring).
 * Pedestrians are like traffic: only nearby.
 */

/**
 * Half the side of the square a player gets, in blocks. On foot the camera shows about 11 blocks
 * either side on a 16:9 screen; flat out in a sports car about 27.
 */
const VIEW_RADIUS = 16;
const VIEW_RADIUS_PER_SPEED = 0.9;
const MAX_VIEW_RADIUS = 32;

export interface View {
  x: number;
  y: number;
  radius: number;
}

export function viewFor(world: World, pedId: number): View | null {
  const ped = world.peds.get(pedId);
  if (!ped) return null;
  const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
  const speed = car ? carSpeed(car) : 0;
  return { x: ped.x, y: ped.y, radius: Math.min(VIEW_RADIUS + speed * VIEW_RADIUS_PER_SPEED, MAX_VIEW_RADIUS) };
}

function sees(view: View, x: number, y: number): boolean {
  return Math.abs(x - view.x) <= view.radius && Math.abs(y - view.y) <= view.radius;
}

/** The part of the world one player gets to see. `playerPeds`: every player's ped. */
export function visibleSnapshot(snapshot: Snapshot, view: View | null, playerPeds: ReadonlySet<number>): Snapshot {
  if (!view) return snapshot;
  return {
    ...snapshot,
    peds: snapshot.peds.filter((p) => playerPeds.has(p.id) || sees(view, p.x, p.y)),
    cars: snapshot.cars.filter((c) => (c.driverId !== null && playerPeds.has(c.driverId)) || sees(view, c.x, c.y)),
    projectiles: snapshot.projectiles.filter((p) => sees(view, p.x, p.y)),
  };
}

/**
 * Players' deaths and wrecked cars go to everyone (kill feed, scoring); pedestrians' deaths, sparks
 * and explosions only to those who can see them.
 */
export function visibleEvents(events: readonly GameEvent[], view: View | null, playerPeds: ReadonlySet<number>): GameEvent[] {
  if (!view) return [...events];
  return events.filter((e) => (e.type === 'death' && playerPeds.has(e.pedId)) || e.type === 'carDestroyed' || sees(view, e.x, e.y));
}

/** Traffic's and pedestrians' AI state is only needed on the server: don't send it. */
export function forClients(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    cars: snapshot.cars.map((c) => (c.traffic ? { ...c, traffic: null } : c)),
    peds: snapshot.peds.map((p) => (p.ai ? { ...p, ai: null } : p)),
  };
}
