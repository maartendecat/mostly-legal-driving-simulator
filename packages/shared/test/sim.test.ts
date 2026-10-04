import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CITY_BLOCKS,
  CAR_MODELS,
  NO_INPUT,
  carCollides,
  carSpeed,
  cloneWorld,
  createWorld,
  generateCity,
  pedCollides,
  spawnPed,
  stepWorld,
  type Car,
  type PlayerInput,
  type World,
  createMap,
  wrapAngle,
  type CarModelId,
  spawnCar,
} from '../src/index';

function firstCar(world: World): Car {
  const car = world.cars.values().next().value;
  assert.ok(car, 'map should spawn cars');
  return car;
}

function input(overrides: Partial<PlayerInput>): PlayerInput {
  return { ...NO_INPUT, ...overrides };
}

test('the same seed generates the same city', () => {
  const a = generateCity(42, 6);
  const b = generateCity(42, 6);
  assert.deepEqual(a.kinds, b.kinds);
  assert.deepEqual(a.levels, b.levels);
  assert.deepEqual(a.carSpawns, b.carSpawns);
  assert.ok(a.carSpawns.length > 10);
  assert.ok(a.pedSpawns.length > 10);
});

test('spawned cars and peds do not start inside walls', () => {
  const world = createWorld(generateCity(7, 6), 7);
  for (const car of world.cars.values()) {
    assert.ok(!carCollides(world.map, CAR_MODELS[car.model], car.x, car.y, car.heading), `car ${car.id} spawns in a wall`);
  }
  for (const spawn of world.map.pedSpawns) assert.ok(!pedCollides(world.map, spawn.x, spawn.y));
});

test('a ped can enter a nearby car, drive it forward and get out again', () => {
  const world = createWorld(generateCity(1, 6), 1);
  const car = firstCar(world);
  const ped = spawnPed(world, car.x, car.y);
  const inputs = new Map([[ped.id, input({ enter: true })]]);

  stepWorld(world, inputs);
  assert.equal(ped.carId, car.id);
  assert.equal(car.driverId, ped.id);

  const start = { x: car.x, y: car.y };
  inputs.set(ped.id, input({ up: true }));
  for (let i = 0; i < 30; i++) stepWorld(world, inputs);
  assert.ok(carSpeed(car) > 2, `car should accelerate, speed=${carSpeed(car)}`);
  const along = (car.x - start.x) * Math.cos(car.heading) + (car.y - start.y) * Math.sin(car.heading);
  assert.ok(along > 0.5, 'car should move forward along its heading');
  assert.equal(ped.x, car.x, 'driver follows the car');

  inputs.set(ped.id, input({ down: true }));
  for (let i = 0; i < 120; i++) stepWorld(world, inputs);
  inputs.set(ped.id, input({ enter: true }));
  stepWorld(world, inputs);
  assert.equal(ped.carId, null);
  assert.equal(car.driverId, null);
  assert.ok(!pedCollides(world.map, ped.x, ped.y));
});

test('cars never end up inside buildings, even when driven flat out while steering', () => {
  const world = createWorld(generateCity(3, 6), 3);
  const car = firstCar(world);
  const ped = spawnPed(world, car.x, car.y);
  const inputs = new Map([[ped.id, input({ enter: true })]]);
  stepWorld(world, inputs);

  for (let i = 0; i < 1200; i++) {
    const phase = Math.floor(i / 90) % 4;
    inputs.set(ped.id, input({ up: true, left: phase === 1, right: phase === 3, handbrake: phase === 2 && i % 3 === 0 }));
    stepWorld(world, inputs);
    for (const c of world.cars.values()) {
      assert.ok(!carCollides(world.map, CAR_MODELS[c.model], c.x, c.y, c.heading), `car ${c.id} inside a wall at tick ${world.tick}`);
    }
  }
});

test('peds cannot walk through buildings', () => {
  const world = createWorld(generateCity(5, 6), 5);
  const ped = spawnPed(world);
  const inputs = new Map([[ped.id, input({ up: true })]]);
  for (let i = 0; i < 1200; i++) {
    inputs.set(ped.id, input({ up: true, left: i % 200 < 20 }));
    stepWorld(world, inputs);
    assert.ok(!pedCollides(world.map, ped.x, ped.y), `ped inside a wall at tick ${world.tick}`);
  }
});

test('replaying inputs on a copy of the world reproduces the same state (needed for reconciliation)', () => {
  const world = createWorld(generateCity(9, 6), 9);
  const car = firstCar(world);
  const ped = spawnPed(world, car.x, car.y);
  const start = { x: car.x, y: car.y };
  const script = (tick: number) => input({ enter: tick === 0, up: tick > 5, left: tick % 40 < 15, handbrake: tick % 60 > 50 });

  let copy: World | undefined;
  for (let tick = 0; tick < 200; tick++) {
    if (tick === 120) copy = cloneWorld(world);
    stepWorld(world, new Map([[ped.id, script(tick)]]));
  }
  for (let tick = 120; tick < 200; tick++) stepWorld(copy!, new Map([[ped.id, script(tick)]]));

  assert.deepEqual([...copy!.cars.values()], [...world.cars.values()]);
  assert.deepEqual([...copy!.peds.values()], [...world.peds.values()]);
  const end = world.cars.get(car.id)!;
  assert.ok(Math.hypot(end.x - start.x, end.y - start.y) > 3, 'the scripted drive should actually move the car');
});

test('cloneWorld does not share entity objects with the original', () => {
  const world = createWorld(generateCity(2, 6), 2);
  const copy = cloneWorld(world);
  firstCar(copy).x += 5;
  assert.notEqual(firstCar(copy).x, firstCar(world).x);
});

test('the city is 12 × 12 blocks (149 × 149 cells), with turf, crates, bribes and spray shops to match', () => {
  const map = generateCity(1234);
  assert.equal(CITY_BLOCKS, 12);
  assert.deepEqual([map.width, map.height], [149, 149]);
  assert.deepEqual([map.carSpawns.length, map.pedSpawns.length, map.pickupSpawns.length, map.bribeSpawns.length, map.sprayShops.length], [84, 96, 64, 6, 4]);
  const turf = [0, 0, 0, 0];
  for (const gang of map.territory) turf[gang]!++;
  // Each gang: a 4 × 4-block corner (the 6 × 6 city's 2 × 2, scaled).
  assert.ok(turf.slice(1).every((cells) => cells === turf[1] && cells > 1000), String(turf));
});

test('a full big city replays identically (the car grid is derived, not state)', () => {
  const world = createWorld(generateCity(7), 7, { traffic: 40, pedestrians: 100, gangMembers: 15, cops: 15, policeCars: 5, fireTrucks: 3 });
  spawnPed(world);
  for (let i = 0; i < 300; i++) stepWorld(world, new Map());
  const copy = cloneWorld(world);
  for (let i = 0; i < 300; i++) {
    stepWorld(world, new Map());
    stepWorld(copy, new Map());
  }
  assert.deepEqual([...copy.cars.values()], [...world.cars.values()]);
  assert.deepEqual([...copy.peds.values()], [...world.peds.values()]);
});

/** A car on an empty, wall-free map, with a driver, going `speed` east. */
function openRoad(model: CarModelId, speed: number) {
  const map = createMap(300, 300);
  map.kinds.fill(0);
  const world = createWorld(map, 1);
  const car = spawnCar(world, model, 150, 150, 0);
  const driver = spawnPed(world, car.x, car.y);
  car.driverId = driver.id;
  driver.carId = car.id;
  car.vx = speed;
  const drive = (ticks: number, input: Partial<PlayerInput>) => {
    for (let i = 0; i < ticks; i++) stepWorld(world, new Map([[driver.id, { ...NO_INPUT, ...input }]]));
  };
  const slip = () => Math.abs(wrapAngle(Math.atan2(car.vy, car.vx) - car.heading));
  return { car, drive, slip };
}

test('handling: cars keep their speed through a turn, and fast ones turn wider (understeer)', () => {
  const fast = openRoad('sports', 18);
  fast.drive(120, { up: true, left: true });
  assert.ok(carSpeed(fast.car) > 17, `kept its speed: ${carSpeed(fast.car).toFixed(1)}`);
  // Turning rate at top speed vs at a third of it: understeer takes some steering away.
  const rate = (speed: number) => {
    const road = openRoad('sedan', speed);
    road.drive(1, { up: true, left: true });
    return road.car.angVel;
  };
  assert.ok(rate(13) < rate(5) * 0.75, `${rate(13).toFixed(2)} vs ${rate(5).toFixed(2)} rad/s`);
});

test('handling: turning harder than the tyres grip slides the car wide; trucks hold on', () => {
  const sedan = openRoad('sedan', 13);
  sedan.drive(60, { up: true, left: true });
  assert.ok(sedan.slip() > 0.15, `the sedan slides (${((sedan.slip() * 180) / Math.PI).toFixed(0)}°)`);
  const truck = openRoad('truck', 9);
  truck.drive(60, { up: true, left: true });
  assert.ok(truck.slip() < 0.05, 'the truck holds on');
});

test('handling: a handbrake turn swings the car round sideways, and it straightens out afterwards', () => {
  const { car, drive, slip } = openRoad('sedan', 10);
  drive(24, { handbrake: true, left: true });
  assert.ok(car.heading > 1, `swung round (${((car.heading * 180) / Math.PI).toFixed(0)}°)`);
  assert.ok(slip() > 1, 'sliding sideways');
  drive(60, { up: true });
  assert.ok(slip() < 0.05, 'and back in line');
  assert.ok(carSpeed(car) > 5, 'driving on');
});
