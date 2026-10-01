import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUSTED_TICKS,
  DEFAULT_MATCH_SETTINGS,
  Match,
  NO_INPUT,
  PED_MAX_HEALTH,
  WANTED_TICKS,
  cloneWorld,
  createWorld,
  damageCar,
  damagePed,
  generateCity,
  isBusted,
  reportCrime,
  roadPath,
  secondsToTicks,
  spawnCar,
  spawnPed,
  spawnPedestrian,
  startTraffic,
  stepWorld,
  type Car,
  type Ped,
  type World,
} from '../src/index';

const run = (world: World, ticks: number, each?: () => void) => {
  for (let i = 0; i < ticks; i++) {
    stepWorld(world, new Map());
    each?.();
  }
};
const cops = (world: World) => [...world.peds.values()].filter((p) => p.kind === 'cop');

/** A quiet city with a police car (driving, crewed) on the eastbound lane of the first road (y=1.5). */
function policeCar(): { world: World; police: Car } {
  const world = createWorld(generateCity(1), 1);
  world.cars.clear();
  world.pickups.clear();
  const police = spawnCar(world, 'sedan', 20.5, 1.5, 0);
  police.police = true;
  startTraffic(world, police);
  return { world, police };
}

/** A player driving `model` at `speed` along the same lane, `gap` blocks behind the police car. */
function chaser(world: World, police: Car, gap: number, speed: number): { player: Ped; car: Car } {
  const car = spawnCar(world, 'sedan', police.x - gap, police.y, 0);
  const player = spawnPed(world, car.x, car.y);
  car.driverId = player.id;
  player.carId = car.id;
  car.vx = speed;
  return { player, car };
}

test('ramming a police car gets the police after you at once', () => {
  const { world, police } = policeCar();
  police.traffic = null; // standing still
  const { player } = chaser(world, police, 1.3, 6);
  let announced = false;
  run(world, 20, () => (announced ||= world.events.some((e) => e.type === 'wanted' && e.pedId === player.id)));
  assert.equal(player.wanted, 1);
  assert.ok(announced, 'announced');
  assert.deepEqual(world.wanted.map((w) => w.pedId), [player.id]);
});

test('merely touching a police car is no crime; ramming another car is none either', () => {
  const { world, police } = policeCar();
  police.traffic = null;
  const { player } = chaser(world, police, 1.2, 0.5);
  run(world, 30, () => stepWorld(world, new Map([[player.id, { ...NO_INPUT, up: false }]])));
  assert.equal(player.wanted, 0);
  police.police = false;
  const other = chaser(world, police, 3, 8);
  run(world, 30);
  assert.equal(other.player.wanted, 0);
});

test('hurting a cop or a police car is a crime; hurting anyone else is not (as far as the police care)', () => {
  const { world, police } = policeCar();
  const a = spawnPed(world, 10.5, 4.5);
  const b = spawnPed(world, 12.5, 4.5);
  const c = spawnPed(world, 14.5, 4.5);
  damagePed(world, spawnPedestrian(world, 8, 4, 'cop'), 10, a.id, 'pistol');
  damageCar(world, police, 10, b.id);
  damagePed(world, spawnPedestrian(world, 16, 4), 10, c.id, 'pistol');
  assert.deepEqual([a.wanted, b.wanted, c.wanted], [1, 1, 0]);
});

test('stealing a police car: both cops get out, and they are after you; floor it and you get away', () => {
  const { world, police } = policeCar();
  police.vx = 0;
  const player = spawnPed(world, police.x, police.y + 0.6);
  stepWorld(world, new Map([[player.id, { ...NO_INPUT, enter: true }]]));
  assert.equal(player.carId, police.id);
  assert.equal(cops(world).length, 2);
  assert.equal(player.wanted, 1);
  for (let i = 0; i < 90; i++) stepWorld(world, new Map([[player.id, { ...NO_INPUT, up: true }]]));
  assert.equal(player.respawnAt, null, 'not busted');
  assert.equal(player.carId, police.id);
});

test('standing still in a stolen police car is asking for it', () => {
  const { world, police } = policeCar();
  police.vx = 0;
  const player = spawnPed(world, police.x, police.y + 0.6);
  stepWorld(world, new Map([[player.id, { ...NO_INPUT, enter: true }]]));
  run(world, secondsToTicks(2));
  assert.ok(isBusted(player));
});

test('a cop who reaches a wanted player on foot arrests them: BUSTED, unarmed, back a moment later', () => {
  const { world } = policeCar();
  world.cars.clear();
  const player = spawnPed(world, 12.5, 4.5);
  Object.assign(player, { weapon: 'pistol', ammo: { pistol: 20 }, health: 60 });
  const cop = spawnPedestrian(world, 8, 4, 'cop');
  const match = new Match({ ...DEFAULT_MATCH_SETTINGS, modes: ['frag'] }, world);
  match.addPlayer(world, player.id);
  reportCrime(world, player.id);
  let busted = false;
  for (let i = 0; i < secondsToTicks(5) && !busted; i++) {
    stepWorld(world, new Map());
    match.update(world);
    busted = world.events.some((e) => e.type === 'busted' && e.pedId === player.id && e.copId === cop.id);
  }
  assert.ok(busted, 'busted');
  assert.ok(isBusted(player));
  assert.deepEqual([player.weapon, player.ammo, player.wanted, world.wanted.length], [null, {}, 0, 0]);
  assert.equal(match.scores.get(player.id)!.deaths, 1, 'counts as a death');
  assert.equal(match.scores.get(player.id)!.frags, 0);
  run(world, BUSTED_TICKS + 1);
  assert.equal(player.respawnAt, null);
  assert.equal(player.health, PED_MAX_HEALTH);
});

test('cops cannot arrest someone driving off; once the car stops, they can', () => {
  const { world, police } = policeCar();
  world.cars.delete(police.id);
  const car = spawnCar(world, 'sedan', 30.5, 1.5, 0);
  const player = spawnPed(world, car.x, car.y);
  car.driverId = player.id;
  player.carId = car.id;
  const cop = spawnPedestrian(world, 30, 4, 'cop');
  reportCrime(world, player.id);
  // Creeping along at walking pace with the cop alongside: not busted.
  for (let i = 0; i < 60; i++) {
    car.vx = 2;
    car.vy = 0;
    stepWorld(world, new Map());
  }
  assert.equal(player.respawnAt, null);
  assert.ok(Math.hypot(cop.x - car.x, cop.y - car.y) < 1.5, 'the cop keeps up');
  car.vx = 0;
  run(world, 60);
  assert.ok(isBusted(player));
  assert.equal(car.driverId, null, 'taken out of the car');
});

test('police cars nearby chase a wanted player along the roads, pull up, and the cops get out for the arrest', () => {
  const world = createWorld(generateCity(3), 3, { traffic: 8, policeCars: 2 });
  run(world, 600);
  const police = [...world.cars.values()].find((c) => c.police && c.traffic)!;
  const spot = world.map.pedSpawns.find((s) => Math.hypot(s.x - police.x, s.y - police.y) > 12 && Math.hypot(s.x - police.x, s.y - police.y) < 19)!;
  const player = spawnPed(world, spot.x, spot.y);
  reportCrime(world, player.id);
  run(world, 1);
  assert.ok(police.siren && police.traffic?.pursuing === player.id, 'giving chase, lights flashing');
  let busted = false;
  run(world, secondsToTicks(15), () => (busted ||= world.events.some((e) => e.type === 'busted' && e.pedId === player.id)));
  assert.ok(busted, 'busted');
  assert.ok(cops(world).length >= 2, 'by the cops from the car');
});

test('out of sight of the police for a while, they give up; their cars go back to driving around', () => {
  const { world, police } = policeCar();
  Object.assign(police, { traffic: null }); // parked, nobody in it: it sees nothing
  const player = spawnPed(world, 60.5, 60.5); // far away, out of sight of any cop
  reportCrime(world, player.id);
  run(world, WANTED_TICKS - 1);
  assert.equal(player.wanted, 1);
  run(world, 2);
  assert.equal(player.wanted, 0);
  assert.equal(world.wanted.length, 0);

  // A police car that was chasing them goes back to driving around.
  startTraffic(world, police);
  reportCrime(world, player.id);
  police.traffic!.pursuing = player.id;
  police.siren = true;
  world.wanted[0]!.until = world.tick + 1;
  player.x = police.x + 40; // and they're nowhere near
  run(world, 2);
  assert.equal(player.wanted, 0);
  assert.equal(world.wanted.length, 0);
  assert.equal(police.siren, false);
  assert.equal(police.traffic?.pursuing, null);
});

test('dying clears your record', () => {
  const { world } = policeCar();
  const player = spawnPed(world, 60.5, 60.5);
  reportCrime(world, player.id);
  damagePed(world, player, 1000, null, 'runOver');
  run(world, 1);
  assert.equal(player.wanted, 0);
});

test('the busted are taken away, not left lying there: nobody stares at them', () => {
  const { world } = policeCar();
  world.cars.clear();
  const player = spawnPed(world, 12.5, 4.5);
  spawnPedestrian(world, 8, 4, 'cop');
  const passerBy = spawnPedestrian(world, 15, 4);
  reportCrime(world, player.id);
  run(world, secondsToTicks(3));
  assert.ok(isBusted(player));
  assert.deepEqual(passerBy.ai!.seenBodies, []);
});

test('the city keeps its police cars on the road, besides the other traffic', () => {
  const world = createWorld(generateCity(2), 2, { traffic: 6, policeCars: 2 });
  run(world, 300);
  const traffic = [...world.cars.values()].filter((c) => c.traffic);
  assert.equal(traffic.filter((c) => c.police).length, 2);
  assert.equal(traffic.filter((c) => !c.police).length, 6);
  assert.ok(traffic.filter((c) => c.police).every((c) => c.model === 'sedan'));
});

test('a way along the roads leads from one place to another', () => {
  const map = generateCity(1);
  const path = roadPath(map, 2.5, 2.5, 60.5, 40.5);
  assert.ok(path.length > 10);
  const last = path.at(-1)!;
  assert.ok(Math.hypot(last.x - 60.5, last.y - 40.5) < 4);
});

test('chases replay identically', () => {
  const world = createWorld(generateCity(4), 4, { traffic: 8, pedestrians: 10, cops: 4, policeCars: 2 });
  run(world, 300);
  const player = spawnPed(world, 40.5, 4.5);
  reportCrime(world, player.id);
  const copy = cloneWorld(world);
  run(world, 400);
  run(copy, 400);
  assert.deepEqual([...copy.peds.values()], [...world.peds.values()]);
  assert.deepEqual([...copy.cars.values()], [...world.cars.values()]);
  assert.deepEqual(copy.wanted, world.wanted);
});
