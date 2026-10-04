import { Block, DIRECTIONS, Lane, RoadMarking, createMap, setCell, type BlockKind, type BlockMap, type CarSpawn, type PickupSpawn, type SprayShop } from './map';
import { randomInt, nextRandom, randomPick, type Vec2 } from './math';
import type { WeaponId } from './weapons';

/** Distance between parallel roads, in cells. */
const PERIOD = 12;
/** Road width in cells: a lane in each direction plus a centre lane. */
const ROAD = 3;
const LOT = PERIOD - ROAD - 2;
const BORDER_HEIGHT = 6;
/** The city is this many blocks across (each way): 149 × 149 cells. */
export const CITY_BLOCKS = 12;
/**
 * How many of each thing there are, for a 6 × 6-block city (the original size); bigger cities get
 * more, by area (see scaled): parked cars a little fewer than that, so streets don't clog up.
 */
const CAR_COUNT = 28;
const PED_SPAWN_COUNT = 24;
const PICKUP_COUNT = 16;
/** Cop bribes: a few, far apart... */
const BRIBE_COUNT = 3;
/** ...and spray shops, on opposite sides of town if possible (both doubling, not quadrupling, with a city twice as wide). */
const SPRAY_SHOP_COUNT = 2;
/**
 * Gang turf, as city blocks (bx, by) per gang in a 6 × 6 city: a 2 × 2 corner each (north-west,
 * north-east, south-centre); everything else is neutral. Blocks are counted from the south-west.
 * In bigger cities the same corners, scaled (4 × 4 blocks in a 12 × 12 city).
 */
const GANG_TURF: [gang: number, bx0: number, by0: number][] = [
  [1, 0, 4],
  [2, 4, 4],
  [3, 2, 0],
];
/** Weighted: pistols are common, rocket launchers rare. */
const PICKUP_WEAPONS: WeaponId[] = ['pistol', 'pistol', 'pistol', 'machineGun', 'machineGun', 'rocketLauncher'];

/**
 * Generates a placeholder city: a grid of 3-wide roads with pavements around city blocks that
 * contain buildings, parks and plazas. The same seed always produces the same map, so server and
 * clients can agree on a map by sharing only the seed.
 */
export function generateCity(seed: number, blocks = CITY_BLOCKS): BlockMap {
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
        // Right-hand traffic: the outer rows/columns of each road are lanes, the middle one isn't.
        let lane = 0;
        if (horizontalRoad && verticalRoad) lane = Lane.Intersection;
        else if (horizontalRoad) lane = ly === 0 ? Lane.East : ly === 2 ? Lane.West : 0;
        else lane = lx === 2 ? Lane.North : lx === 0 ? Lane.South : 0;
        map.lanes[y * size + x] = lane;
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

  markTurf(map, blocks);
  const area = (blocks / 6) ** 2;
  const width = blocks / 6;
  map.carSpawns = pickCarSpawns(map, rng, Math.round(CAR_COUNT * area * 0.75));
  map.pedSpawns = pickPedSpawns(map, rng, Math.round(PED_SPAWN_COUNT * area));
  map.pickupSpawns = pickPickupSpawns(map, rng, Math.round(PICKUP_COUNT * area));
  // Last, so adding them didn't change the rest of any city.
  map.bribeSpawns = pickSpread(
    pavementCells(map).filter((c) => map.pickupSpawns.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 4)),
    rng,
    Math.round(BRIBE_COUNT * width),
    20,
  );
  map.sprayShops = pickSprayShops(map, rng, Math.round(SPRAY_SHOP_COUNT * width));
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

/** Marks each gang's blocks (their pavements, buildings and parks; not the roads) as its turf. */
function markTurf(map: BlockMap, blocks: number): void {
  for (let y = 1; y < map.height - 1; y++) {
    for (let x = 1; x < map.width - 1; x++) {
      const lx = (x - 1) % PERIOD;
      const ly = (y - 1) % PERIOD;
      if (lx < ROAD || ly < ROAD) continue;
      const bx = Math.floor((x - 1) / PERIOD);
      const by = Math.floor((y - 1) / PERIOD);
      if (bx >= blocks || by >= blocks) continue;
      // (Turf is given for a 6 × 6 city; scaled to this one.)
      const k = blocks / 6;
      const turf = GANG_TURF.find(([, x0, y0]) => bx >= x0 * k && bx < (x0 + 2) * k && by >= y0 * k && by < (y0 + 2) * k);
      if (turf) map.territory[y * map.width + x] = turf[0];
    }
  }
}

/**
 * Parked cars stand on the pavement along the right-hand kerb, facing the direction of traffic:
 * easy to find and steal, and out of the way of the traffic driving past.
 */
function pickCarSpawns(map: BlockMap, rng: { rngState: number }, count: number): CarSpawn[] {
  const candidates: CarSpawn[] = [];
  for (let y = 1; y < map.height - 1; y++) {
    for (let x = 1; x < map.width - 1; x++) {
      const dir = [Lane.East, Lane.North, Lane.West, Lane.South].indexOf(map.lanes[y * map.width + x] as 1 | 2 | 4 | 8);
      if (dir < 0) continue;
      const d = DIRECTIONS[dir]!;
      // The kerb is on the right of the lane: (dy, -dx).
      const px = x + d.dy;
      const py = y - d.dx;
      if (map.kinds[py * map.width + px] === Block.Pavement) candidates.push({ x: px + 0.5, y: py + 0.5, heading: d.heading });
    }
  }
  return pickSpread(candidates, rng, count, 3);
}

function pickPedSpawns(map: BlockMap, rng: { rngState: number }, count: number): Vec2[] {
  return pickSpread(pavementCells(map), rng, count, 6);
}

function pickPickupSpawns(map: BlockMap, rng: { rngState: number }, count: number): PickupSpawn[] {
  return pickSpread(pavementCells(map), rng, count, 8).map((p) => ({ ...p, weapon: randomPick(rng, PICKUP_WEAPONS) }));
}

/**
 * Spray shops: a bay on the pavement with a building behind it (the garage) and the road in front,
 * along a straight stretch (not a corner). Picked last, so they didn't change any city.
 */
function pickSprayShops(map: BlockMap, rng: { rngState: number }, count: number): SprayShop[] {
  const kind = (x: number, y: number) => (x < 0 || y < 0 || x >= map.width || y >= map.height ? Block.Building : map.kinds[y * map.width + x]);
  const candidates: (SprayShop & { x: number; y: number })[] = [];
  for (const cell of pavementCells(map)) {
    const cx = Math.floor(cell.x);
    const cy = Math.floor(cell.y);
    for (let dir = 0; dir < 4; dir++) {
      const d = DIRECTIONS[dir]!;
      const side = DIRECTIONS[(dir + 1) % 4]!;
      if (kind(cx + d.dx, cy + d.dy) !== Block.Building || kind(cx - d.dx, cy - d.dy) !== Block.Road) continue;
      // Pavement on both sides along the kerb, so it's a straight stretch you can drive into.
      if (kind(cx + side.dx, cy + side.dy) !== Block.Pavement || kind(cx - side.dx, cy - side.dy) !== Block.Pavement) continue;
      if (map.levels[(cy + d.dy) * map.width + cx + d.dx]! < 1) continue;
      candidates.push({ x: cell.x, y: cell.y, dir });
    }
  }
  const away = candidates.filter((c) => map.pickupSpawns.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 3));
  return pickSpread(away, rng, count, 30).map(({ x, y, dir }) => ({ x, y, dir }));
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
