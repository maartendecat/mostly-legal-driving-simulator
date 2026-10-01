import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Block,
  CAR_MODELS,
  DIRECTIONS,
  Lane,
  NO_INPUT,
  PED_MAX_HEALTH,
  carCollides,
  carSpeed,
  cloneWorld,
  createWorld,
  damageCar,
  generateCity,
  laneAt,
  secondsToTicks,
  spawnCar,
  spawnPed,
  startTraffic,
  stepWorld,
  wrapAngle,
  type Car,
  type World,
} from '../src/index';

const trafficCars = (world: World) => [...world.cars.values()].filter((c) => c.traffic);
const run = (world: World, ticks: number, each?: () => void) => {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    each?.();
  }
};

/** A city with no parked cars, and one traffic car on the eastbound lane of a long straight road. */
function oneCar(): { world: World; car: Car } {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  world.pickups.clear();
  // Row y=1 is the eastbound lane of the southernmost road; x=5 is just past the first intersection.
  const car = spawnCar(world, 'sedan', 5.5, 1.5, 0);
  assert.ok(startTraffic(world, car));
  return { world, car };
}

test('the city has right-hand traffic lanes; parked cars stand on the kerb beside one, facing its way', () => {
  const map = generateCity(4);
  for (const spawn of map.carSpawns) {
    const dir = DIRECTIONS.findIndex((d) => Math.abs(wrapAngle(d.heading - spawn.heading)) < 1e-9);
    const d = DIRECTIONS[dir]!;
    const cx = Math.floor(spawn.x);
    const cy = Math.floor(spawn.y);
    assert.equal(map.kinds[cy * map.width + cx], Block.Pavement, `spawn at ${spawn.x},${spawn.y} is on the pavement`);
    assert.equal(laneAt(map, cx - d.dy, cy + d.dx), 1 << dir, 'with its lane on its left');
  }
  // Southernmost road: eastbound on its south row, westbound on its north row (driving on the right).
  assert.equal(laneAt(map, 6, 1), Lane.East);
  assert.equal(laneAt(map, 6, 2), 0, 'the middle row carries no traffic');
  assert.equal(laneAt(map, 6, 3), Lane.West);
  assert.equal(laneAt(map, 2, 2), Lane.Intersection);
  assert.equal(map.kinds[1 * map.width + 6], Block.Road);
});

test('a traffic car drives its lane on its own, through intersections and round corners', () => {
  const { world, car } = oneCar();
  let offRoad = 0;
  let intersections = 0;
  let wasInIntersection = false;
  const headings = new Set<number>();
  let distance = 0;
  let last = { x: car.x, y: car.y };
  run(world, secondsToTicks(60), () => {
    const cell = Math.floor(car.y) * world.map.width + Math.floor(car.x);
    if (world.map.kinds[cell] !== Block.Road) offRoad++;
    const inIntersection = (world.map.lanes[cell]! & Lane.Intersection) !== 0;
    if (inIntersection && !wasInIntersection) intersections++;
    wasInIntersection = inIntersection;
    headings.add(Math.round(wrapAngle(car.heading) / (Math.PI / 2)) & 3);
    distance += Math.hypot(car.x - last.x, car.y - last.y);
    last = { x: car.x, y: car.y };
  });
  assert.ok(car.traffic, 'still driving');
  assert.equal(offRoad, 0, 'never left the road');
  assert.ok(intersections >= 8, `crossed ${intersections} intersections`);
  assert.ok(headings.size >= 3, 'turned corners (drove in several directions)');
  assert.ok(distance / 60 > 3.5, `average speed ${(distance / 60).toFixed(1)} blocks/s`);
  assert.equal(car.health, CAR_MODELS.sedan.health, 'without crashing into anything');
});

test('traffic stops for a moving car in front instead of crashing into it', () => {
  const { world, car } = oneCar();
  // Another traffic car, slower (stuck behind a pedestrian that won't move), right in front.
  const slow = spawnCar(world, 'truck', 9.5, 1.5, 0);
  startTraffic(world, slow);
  spawnPed(world, 12.5, 1.5);
  let closest = Infinity;
  run(world, secondsToTicks(0.6), () => (closest = Math.min(closest, slow.x - car.x)));
  assert.ok(closest > 1.2, `kept its distance (${closest.toFixed(2)})`);
  assert.equal(car.health, CAR_MODELS.sedan.health);
  assert.equal(slow.health, CAR_MODELS.truck.health);
});

test('traffic drives around a parked car through the middle of the road, and back into its lane', () => {
  const { world, car } = oneCar();
  const parked = spawnCar(world, 'truck', 10.5, 1.5, 0);
  let usedMiddle = false;
  run(world, secondsToTicks(6), () => (usedMiddle ||= Math.floor(car.y) === 2));
  assert.ok(usedMiddle, 'swung out into the middle row');
  assert.ok(car.x > parked.x + 2, 'got past');
  assert.equal(Math.floor(car.y), 1, 'back in its lane');
  assert.equal(car.health, CAR_MODELS.sedan.health);
  assert.equal(parked.health, CAR_MODELS.truck.health);
});

test('traffic stops for people on the road', () => {
  const { world } = oneCar();
  const ped = spawnPed(world, 11.5, 1.5);
  run(world, secondsToTicks(5));
  assert.equal(ped.health, PED_MAX_HEALTH);
});

test('getting into a traffic car makes it yours', () => {
  const { world, car } = oneCar();
  run(world, 30);
  car.vx = car.vy = 0;
  const ped = spawnPed(world, car.x, car.y + 0.6);
  stepWorld(world, new Map([[ped.id, { ...NO_INPUT, enter: true }]]));
  assert.equal(ped.carId, car.id);
  assert.equal(car.traffic, null);
  const before = car.heading;
  run(world, 1);
  for (let i = 0; i < 30; i++) stepWorld(world, new Map([[ped.id, { ...NO_INPUT, up: true, left: true }]]));
  assert.ok(Math.abs(wrapAngle(car.heading - before)) > 0.3, 'it goes where the player steers');
});

test('the driver of a burning car bails out; the car stops', () => {
  const { world, car } = oneCar();
  run(world, 60);
  damageCar(world, car, 1000, null);
  run(world, 1);
  assert.equal(car.traffic, null);
});

test('traffic is kept at the target, appearing out of sight of players, and wrecks get replaced', () => {
  const world = createWorld(generateCity(2), 2, { traffic: 10 });
  const player = spawnPed(world, 40.5, 40.5);
  // Check where each traffic car is on the tick it appears (after that it may well drive closer).
  const seen = new Set<number>();
  run(world, 60, () => {
    for (const car of trafficCars(world)) {
      if (seen.has(car.id)) continue;
      seen.add(car.id);
      assert.ok(Math.hypot(car.x - player.x, car.y - player.y) > 14, 'appeared out of sight');
    }
  });
  assert.equal(trafficCars(world).length, 10);

  const victim = trafficCars(world)[0]!;
  damageCar(world, victim, 1000, null);
  run(world, 30);
  assert.equal(trafficCars(world).length, 10, 'replaced');
});

test('a busy city keeps flowing: no gridlock, nobody inside walls', () => {
  const world = createWorld(generateCity(3), 3, { traffic: 16 });
  run(world, secondsToTicks(90));
  const traffic = trafficCars(world);
  assert.equal(traffic.length, 16);
  const moving = traffic.filter((c) => carSpeed(c) > 1).length;
  assert.ok(moving >= traffic.length * 0.5, `${moving} of ${traffic.length} traffic cars moving after 90 s`);
  for (const car of world.cars.values()) assert.ok(!carCollides(world.map, CAR_MODELS[car.model], car.x, car.y, car.heading));
});

test('traffic replays identically, so prediction agrees with the server', () => {
  const world = createWorld(generateCity(5), 5, { traffic: 12 });
  run(world, 300);
  const copy = cloneWorld(world);
  run(world, 300);
  run(copy, 300);
  assert.deepEqual([...copy.cars.values()], [...world.cars.values()]);
  assert.equal(copy.rngState, world.rngState);
});
