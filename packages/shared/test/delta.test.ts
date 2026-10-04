import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO_INPUT,
  applyDelta,
  captureSnapshot,
  createWorld,
  encodeDelta,
  generateCity,
  quantizeSnapshot,
  spawnPed,
  stepWorld,
  type Snapshot,
  type World,
} from '../src/index';

/** Entities sorted by id, so snapshots can be compared regardless of order. */
function normalized(snapshot: Snapshot): Snapshot {
  const byId = <T extends { id: number }>(list: T[]) => [...list].sort((a, b) => a.id - b.id);
  return { ...snapshot, cars: byId(snapshot.cars), peds: byId(snapshot.peds), projectiles: byId(snapshot.projectiles), pickups: byId(snapshot.pickups) };
}

/** A busy few seconds: two players driving, one shooting, cars crashing, someone dying. */
function busyWorld(): { world: World; step: (tick: number) => void } {
  const world = createWorld(generateCity(3, 6), 3);
  const car = world.cars.values().next().value!;
  const driver = spawnPed(world, car.x, car.y);
  const gunner = spawnPed(world, 2.5, 30.5);
  Object.assign(gunner, { heading: Math.PI / 2, weapon: 'machineGun', ammo: { machineGun: 300 } });
  spawnPed(world, 2.5, 33.5); // target
  return {
    world,
    step: (tick) =>
      stepWorld(
        world,
        new Map([
          [driver.id, { ...NO_INPUT, enter: tick === 0, up: tick > 3, left: tick % 50 < 12, handbrake: tick % 70 > 60 }],
          [gunner.id, { ...NO_INPUT, fire: true, left: tick % 40 < 3 }],
        ]),
      ),
  };
}

test('applying each delta rebuilds exactly the snapshot the server sent', () => {
  const { world, step } = busyWorld();
  let sent = quantizeSnapshot(captureSnapshot(world));
  let received = sent;
  let added = 0;
  let removed = 0;
  for (let tick = 0; tick < 400; tick++) {
    step(tick);
    const next = quantizeSnapshot(captureSnapshot(world));
    const delta = encodeDelta(sent, next);
    added += delta.projectiles.set?.filter((p) => 'kind' in p).length ?? 0;
    removed += delta.projectiles.remove?.length ?? 0;
    received = applyDelta(received, JSON.parse(JSON.stringify(delta)));
    sent = next;
    assert.deepEqual(normalized(received), normalized(sent), `tick ${world.tick}`);
  }
  assert.ok(added > 20 && removed > 20, `bullets came and went (${added} added, ${removed} removed)`);
});

test('a quiet city costs almost nothing: unchanged entities are not sent', () => {
  const world = createWorld(generateCity(1, 6), 1);
  spawnPed(world);
  const before = quantizeSnapshot(captureSnapshot(world));
  stepWorld(world, new Map());
  const after = quantizeSnapshot(captureSnapshot(world));
  const full = JSON.stringify(after).length;
  const delta = JSON.stringify(encodeDelta(before, after)).length;
  assert.ok(delta < 200, `delta ${delta} bytes (full snapshot ${full})`);
  assert.ok(full > 5000);
});

test('a delta only carries the fields that changed', () => {
  const world = createWorld(generateCity(1, 6), 1);
  const ped = spawnPed(world);
  const before = quantizeSnapshot(captureSnapshot(world));
  stepWorld(world, new Map([[ped.id, { ...NO_INPUT, left: true }]]));
  const delta = encodeDelta(before, quantizeSnapshot(captureSnapshot(world)));
  assert.deepEqual(delta.peds.set?.map((p) => Object.keys(p).sort()), [['heading', 'id']]);
  assert.equal(delta.cars.set, undefined);
});

test('quantizing keeps numbers within 0.0001 and leaves whole numbers alone', () => {
  const world = createWorld(generateCity(1, 6), 1);
  const car = world.cars.values().next().value!;
  Object.assign(car, { x: 12.3456789, heading: Math.PI, health: 80 });
  const sent = quantizeSnapshot(captureSnapshot(world)).cars.find((c) => c.id === car.id)!;
  assert.equal(sent.x, 12.3457);
  assert.equal(sent.heading, 3.1416);
  assert.equal(sent.health, 80);
  assert.ok(Math.abs(sent.x - car.x) <= 0.00005);
});
