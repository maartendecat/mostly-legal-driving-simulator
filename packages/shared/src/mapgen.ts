import { Block, RoadMarking, createMap, setCell, type BlockKind, type BlockMap, type CarSpawn, type PickupSpawn } from './map';
import { randomInt, nextRandom, randomPick, type Vec2 } from './math';
import type { WeaponId } from './weapons';

/** Distance between parallel roads, in cells. */
const PERIOD = 12;
/** Road width in cells: a lane in each direction plus a centre lane. */
const ROAD = 3;
const LOT = PERIOD - ROAD - 2;
const BORDER_HEIGHT = 6;
const CAR_COUNT = 28;
const PED_SPAWN_COUNT = 24;
const PICKUP_COUNT = 16;
/** Weighted: pistols are common, rocket launchers rare. */
const PICKUP_WEAPONS: WeaponId[] = ['pistol', 'pistol', 'pistol', 'machineGun', 'machineGun', 'rocketLauncher'];

/**
 * Generates a placeholder city: a grid of 3-wide roads with pavements around city blocks that
 * contain buildings, parks and plazas. The same seed always produces the same map, so server and
 * clients can agree on a map by sharing only the seed.
 */
export function generateCity(seed: number, blocks = 6): BlockMap {
  const size = blocks * PERIOD + ROAD + 2;
  const map = createMap(size, size);
  const rng = { rngState: seed >>> 0 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
        setCell(map, x, y, Block.Building, BORDER_HEIGHT);
        continue;
      }
      const lx = (x - 1) % PERIOD;
      const ly = (y - 1) % PERIOD;
      const horizontalRoad = ly < ROAD;
      const verticalRoad = lx < ROAD;
      if (horizontalRoad || verticalRoad) {
        let marking: number = RoadMarking.None;
        if (horizontalRoad && !verticalRoad && ly === 1) marking = RoadMarking.CenterHorizontal;
        if (verticalRoad && !horizontalRoad && lx === 1) marking = RoadMarking.CenterVertical;
        setCell(map, x, y, Block.Road, 0, marking);
      } else if (lx === ROAD || lx === PERIOD - 1 || ly === ROAD || ly === PERIOD - 1) {
        setCell(map, x, y, Block.Pavement);
      } else {
        setCell(map, x, y, Block.Grass);
      }
    }
  }

  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      fillLot(map, rng, 1 + bx * PERIOD + ROAD + 1, 1 + by * PERIOD + ROAD + 1);
    }
  }

  map.carSpawns = pickCarSpawns(map, rng);
  map.pedSpawns = pickPedSpawns(map, rng);
  map.pickupSpawns = pickPickupSpawns(map, rng);
  return map;
}

function fillLot(map: BlockMap, rng: { rngState: number }, x0: number, y0: number): void {
  const roll = nextRandom(rng);
  if (roll < 0.15) return; // park: leave grass
  if (roll < 0.25) {
    fillRect(map, x0, y0, LOT, LOT, Block.Pavement);
    return;
  }
  // Split the lot into four buildings of different heights; some become courtyards.
  const splitX = 3 + randomInt(rng, 2);
  const splitY = 3 + randomInt(rng, 2);
  const rects: [number, number, number, number][] = [
    [x0, y0, splitX, splitY],
    [x0 + splitX, y0, LOT - splitX, splitY],
    [x0, y0 + splitY, splitX, LOT - splitY],
    [x0 + splitX, y0 + splitY, LOT - splitX, LOT - splitY],
  ];
  for (const [x, y, w, h] of rects) {
    if (nextRandom(rng) < 0.15) {
      fillRect(map, x, y, w, h, Block.Pavement);
    } else {
      const level = 1 + randomInt(rng, 5);
      const variant = randomInt(rng, 6);
      fillRect(map, x, y, w, h, Block.Building, level, variant);
    }
  }
}

function fillRect(map: BlockMap, x0: number, y0: number, w: number, h: number, kind: BlockKind, level = 0, variant = 0): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setCell(map, x, y, kind, level, variant);
  }
}

/** Cars start parked in the right-hand lane, facing the direction of traffic. */
function pickCarSpawns(map: BlockMap, rng: { rngState: number }): CarSpawn[] {
  const candidates: CarSpawn[] = [];
  for (let y = 1; y < map.height - 1; y++) {
    for (let x = 1; x < map.width - 1; x++) {
      const lx = (x - 1) % PERIOD;
      const ly = (y - 1) % PERIOD;
      const horizontalRoad = ly < ROAD;
      const verticalRoad = lx < ROAD;
      if (horizontalRoad === verticalRoad) continue; // skip intersections and non-road cells
      if (horizontalRoad && ly !== 1) {
        candidates.push({ x: x + 0.5, y: y + 0.5, heading: ly === 0 ? 0 : Math.PI });
      } else if (verticalRoad && lx !== 1) {
        candidates.push({ x: x + 0.5, y: y + 0.5, heading: lx === 2 ? Math.PI / 2 : -Math.PI / 2 });
      }
    }
  }
  return pickSpread(candidates, rng, CAR_COUNT, 3);
}

function pickPedSpawns(map: BlockMap, rng: { rngState: number }): Vec2[] {
  return pickSpread(pavementCells(map), rng, PED_SPAWN_COUNT, 6);
}

function pickPickupSpawns(map: BlockMap, rng: { rngState: number }): PickupSpawn[] {
  return pickSpread(pavementCells(map), rng, PICKUP_COUNT, 8).map((p) => ({ ...p, weapon: randomPick(rng, PICKUP_WEAPONS) }));
}

function pavementCells(map: BlockMap): Vec2[] {
  const cells: Vec2[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.kinds[y * map.width + x] === Block.Pavement) cells.push({ x: x + 0.5, y: y + 0.5 });
    }
  }
  return cells;
}

/** Picks up to `count` random candidates that are at least `minDistance` apart. */
function pickSpread<T extends Vec2>(candidates: T[], rng: { rngState: number }, count: number, minDistance: number): T[] {
  const picked: T[] = [];
  for (let attempt = 0; attempt < count * 20 && picked.length < count && candidates.length > 0; attempt++) {
    const c = candidates[randomInt(rng, candidates.length)]!;
    if (picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= minDistance)) picked.push(c);
  }
  return picked;
}
