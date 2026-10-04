import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAR_BURN_TICKS,
  NO_INPUT,
  SPRAY_RANGE,
  WRECK_BURN_TICKS,
  WRECK_TICKS,
  cloneWorld,
  createWorld,
  damageCar,
  generateCity,
  isBurningWreck,
  isFireTruck,
  secondsToTicks,
  spawnCar,
  spawnPed,
  stepWorld,
  type Car,
  type World,
} from '../src/index';

const run = (world: World, ticks: number, each?: () => void) => {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    each?.();
  }
};
const trucks = (world: World) => [...world.cars.values()].filter(isFireTruck);

/** A city with a player watching a parked car that's about to blow up. */
function fire(options: { fireTrucks?: number; seed?: number } = {}): { world: World; wreck: Car } {
  const seed = options.seed ?? 3;
  const world = createWorld(generateCity(seed, 6), seed, { fireTrucks: options.fireTrucks ?? 2 });
  const wreck = world.cars.values().next().value!;
  spawnPed(world, wreck.x, wreck.y + 4);
  damageCar(world, wreck, 1000, null);
  run(world, CAR_BURN_TICKS + 1);
  assert.ok(isBurningWreck(wreck));
  return { world, wreck };
}

test('a wreck burns for a while, then burns out, and is cleared away as before', () => {
  const { world, wreck } = fire({ fireTrucks: 0 });
  run(world, WRECK_BURN_TICKS - 2);
  assert.ok(isBurningWreck(wreck), 'still burning');
  run(world, 2);
  assert.equal(wreck.burnsUntil, null, 'burnt out');
  run(world, WRECK_TICKS - WRECK_BURN_TICKS);
  assert.ok(!world.cars.has(wreck.id), 'cleared away');
  assert.equal(trucks(world).length, 0, 'no fire brigade in this city');
});

test('a fire truck comes from out of sight, lights flashing, puts the fire out, and leaves again', () => {
  const { world, wreck } = fire();
  const player = [...world.peds.values()].find((p) => p.kind === 'player')!;
  run(world, secondsToTicks(1));
  const [truck] = trucks(world);
  assert.ok(truck, 'on its way');
  assert.ok(truck.siren);
  assert.equal(truck.traffic?.fire, wreck.id);
  const start = Math.hypot(truck.x - player.x, truck.y - player.y);
  assert.ok(start > 14, `appeared ${start.toFixed(0)} blocks from the player`);

  let sprayDistance = -1;
  let outAt = -1;
  run(world, secondsToTicks(25), () => {
    if (truck.spray && sprayDistance < 0) sprayDistance = Math.hypot(truck.x - wreck.x, truck.y - wreck.y);
    if (outAt < 0 && !isBurningWreck(wreck)) outAt = world.tick;
  });
  assert.ok(sprayDistance > 0 && sprayDistance <= SPRAY_RANGE, `sprayed water from ${sprayDistance.toFixed(1)} blocks`);
  assert.ok(outAt > 0, 'the fire is out');
  assert.ok(isBurningWreck(wreck) === false && world.cars.has(wreck.id), 'the wreck stays a while after the fire is out');
  run(world, secondsToTicks(30));
  assert.ok(!world.cars.has(truck.id), 'and the truck went back to the station');
});

test('no more fire trucks out at once than the city has', () => {
  const world = createWorld(generateCity(4, 6), 4, { fireTrucks: 1 });
  spawnPed(world, 2.5, 2.5);
  const cars = [...world.cars.values()].slice(0, 4);
  for (const car of cars) damageCar(world, car, 1000, null);
  let most = 0;
  run(world, secondsToTicks(20), () => (most = Math.max(most, trucks(world).filter((t) => t.traffic?.fire != null).length)));
  assert.equal(most, 1);
});

test('fire trucks are only ever sent to fires: never parked, never in the traffic', () => {
  const world = createWorld(generateCity(2, 6), 2, { traffic: 12, fireTrucks: 2 });
  run(world, secondsToTicks(30));
  assert.equal(trucks(world).length, 0);
});

test('a fire truck can be stolen: its crew gets out and the fire is on its own', () => {
  const { world, wreck } = fire();
  run(world, secondsToTicks(1));
  const [truck] = trucks(world);
  const thief = spawnPed(world, truck!.x, truck!.y + 0.8);
  truck!.vx = truck!.vy = 0;
  stepWorld(world, new Map([[thief.id, { ...NO_INPUT, enter: true }]]));
  assert.equal(thief.carId, truck!.id);
  assert.equal(truck!.traffic, null);
  assert.equal(truck!.siren, false);
  assert.ok([...world.peds.values()].some((p) => p.kind === 'civilian'), 'the driver got out');
  assert.ok(isBurningWreck(wreck));
});

test('fire brigade missions replay identically', () => {
  const { world } = fire({ seed: 5 });
  run(world, 60);
  const copy = cloneWorld(world);
  run(world, 600);
  run(copy, 600);
  assert.deepEqual([...copy.cars.values()], [...world.cars.values()]);
});

test('a car that just caught fire is not a fire for the brigade yet: it explodes first', () => {
  const world = createWorld(generateCity(3, 6), 3, { fireTrucks: 2 });
  spawnPed(world, 2.5, 2.5);
  const car = spawnCar(world, 'sedan', 40.5, 1.5, 0);
  damageCar(world, car, 1000, null);
  run(world, CAR_BURN_TICKS - 5);
  assert.equal(trucks(world).length, 0);
});
