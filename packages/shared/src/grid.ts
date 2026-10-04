import type { Car, World } from './world';

/**
 * Finding the cars near a point without looking at every car in the city: they're sorted into
 * square cells of CELL blocks, rebuilt a couple of times per tick (see stepWorld), and a lookup only
 * looks at the cells around the point. Not part of the world state: it's derived, and the same on
 * the server and the predicting client.
 */
const CELL = 8;
/** Cars move this little between rebuilds, so lookups widen their radius by it. */
const MOVE_MARGIN = 0.5;

interface CarGrid {
  cells: Map<number, Car[]>;
}

const grids = new WeakMap<World, CarGrid>();

const key = (cx: number, cy: number) => cx * 4096 + cy;

/** Sorts the world's cars into the grid, as they are now. */
export function buildCarGrid(world: World): void {
  const cells = new Map<number, Car[]>();
  for (const car of world.cars.values()) {
    const k = key(Math.floor(car.x / CELL), Math.floor(car.y / CELL));
    const cell = cells.get(k);
    if (cell) cell.push(car);
    else cells.set(k, [car]);
  }
  grids.set(world, { cells });
}

/**
 * The cars within about `radius` of (x, y) (maybe a few more; callers check the exact distance),
 * from the last rebuild. Without a grid (outside a world step), every car.
 */
export function carsNear(world: World, x: number, y: number, radius: number): Iterable<Car> {
  const grid = grids.get(world);
  if (!grid) return world.cars.values();
  const r = radius + MOVE_MARGIN;
  const result: Car[] = [];
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
    for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
      const cell = grid.cells.get(key(cx, cy));
      if (cell) for (const car of cell) if (world.cars.has(car.id)) result.push(car);
    }
  }
  return result;
}

/** Forgets the grid (at the end of a step): lookups then go through every car again. */
export function clearCarGrid(world: World): void {
  grids.delete(world);
}
