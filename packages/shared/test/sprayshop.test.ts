import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIRECTIONS,
  SPRAY_TICKS,
  createWorld,
  generateCity,
  reportCrime,
  spawnCar,
  spawnPed,
  stepWorld,
  type Car,
  type Ped,
  type World,
} from '../src/index';

const run = (world: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) stepWorld(world, new Map());
};

/** A player driving a car standing in the first spray shop's bay. */
function inTheBay(): { world: World; player: Ped; car: Car } {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  world.pickups.clear();
  const shop = world.map.sprayShops[0]!;
  const d = DIRECTIONS[shop.dir]!;
  const car = spawnCar(world, 'sedan', shop.x, shop.y, Math.atan2(d.dy, d.dx));
  const player = spawnPed(world, car.x, car.y);
  car.driverId = player.id;
  player.carId = car.id;
  return { world, player, car };
}

test('every city has two spray shops: a bay on the pavement, the garage behind it, the road in front', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const map = generateCity(seed);
    assert.equal(map.sprayShops.length, 2);
    for (const shop of map.sprayShops) {
      const d = DIRECTIONS[shop.dir]!;
      const kind = (dx: number, dy: number) => map.kinds[(Math.floor(shop.y) + dy) * map.width + Math.floor(shop.x) + dx];
      assert.deepEqual([kind(0, 0), kind(d.dx, d.dy), kind(-d.dx, -d.dy)], [1, 3, 0], 'pavement, building, road');
    }
  }
});

test('holding still in the bay: a new colour, and the police lose you', () => {
  const { world, player, car } = inTheBay();
  reportCrime(world, player.id, 'killCop');
  assert.equal(player.wanted, 2);
  const colour = car.color;
  run(world, SPRAY_TICKS - 2);
  assert.equal(car.color, colour, 'not yet');
  let sprayed = false;
  for (let i = 0; i < 4; i++) {
    stepWorld(world, new Map());
    sprayed ||= world.events.some((e) => e.type === 'sprayed' && e.pedId === player.id && e.lostThem);
  }
  assert.ok(sprayed, 'announced');
  assert.notEqual(car.color, colour);
  assert.equal(car.paintJobs, 1);
  assert.equal(player.wanted, 0);
  assert.equal(world.wanted.length, 0);
});

test('no paint job for a car driving through, or for a police car', () => {
  const moving = inTheBay();
  const colour = moving.car.color;
  const shop = moving.world.map.sprayShops[0]!;
  const along = DIRECTIONS[(shop.dir + 1) % 4]!;
  for (let i = 0; i < SPRAY_TICKS * 2; i++) {
    // Rolling along the kerb through the bay (kept in it for the test).
    Object.assign(moving.car, { x: shop.x, y: shop.y, vx: along.dx * 2, vy: along.dy * 2, heading: Math.atan2(along.dy, along.dx) });
    stepWorld(moving.world, new Map());
  }
  assert.equal(moving.car.color, colour);

  const police = inTheBay();
  police.car.police = true;
  const before = police.car.color;
  run(police.world, SPRAY_TICKS * 2);
  assert.equal(police.car.color, before);
});

test('pedestrians are not startled by a paint job or a wanted level (only by shots, blasts and deaths)', () => {
  const { world, player } = inTheBay();
  const civilians = () => [...world.peds.values()].filter((p) => p.kind === 'civilian');
  reportCrime(world, player.id, 'killCop');
  run(world, SPRAY_TICKS + 2);
  assert.ok(civilians().every((p) => p.ai!.panicTicks === 0));
});
