import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TransformSnapshot } from '../src/render/transforms';
import { INTERPOLATION_DELAY_TICKS, SnapshotBuffer } from '../src/session/SnapshotBuffer';

const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

/** One entity (id 1) moving along x at one unit per tick. */
function at(x: number): TransformSnapshot {
  return new Map([[1, { x, y: 0, heading: 0 }]]);
}

/** A buffer that received a snapshot every 2 ticks for ticks 0..lastTick, each arriving on time. */
function filledBuffer(lastTick: number): SnapshotBuffer {
  const buffer = new SnapshotBuffer(TICK_RATE);
  for (let tick = 0; tick <= lastTick; tick += 2) buffer.push(tick, at(tick), tick * TICK_MS);
  return buffer;
}

test('draws entities INTERPOLATION_DELAY_TICKS in the past, blending between snapshots', () => {
  const buffer = filledBuffer(20);
  // 20.5 ticks of local time → render tick 14.5, between the snapshots at 14 and 16.
  const x = buffer.sample(20.5 * TICK_MS).get(1)!.x;
  assert.ok(Math.abs(x - (20.5 - INTERPOLATION_DELAY_TICKS)) < 1e-9, `x=${x}`);
});

test('movement stays smooth when a snapshot is lost', () => {
  const buffer = new SnapshotBuffer(TICK_RATE);
  for (let tick = 0; tick <= 20; tick += 2) {
    if (tick === 14) continue; // lost
    buffer.push(tick, at(tick), tick * TICK_MS);
  }
  for (const now of [19, 19.5, 20, 20.5]) {
    const x = buffer.sample(now * TICK_MS).get(1)!.x;
    assert.ok(Math.abs(x - (now - INTERPOLATION_DELAY_TICKS)) < 1e-9, `at ${now}: x=${x}`);
  }
});

test('one late snapshot does not pull the render clock back', () => {
  const buffer = filledBuffer(20);
  const before = buffer.renderTick(22 * TICK_MS);
  buffer.push(22, at(22), 22 * TICK_MS + 80); // arrives 80 ms late
  const after = buffer.renderTick(22 * TICK_MS);
  assert.ok(before - after < 0.1, `render clock moved back by ${before - after} ticks`);
});

test('holds the last known position when snapshots stop arriving', () => {
  const buffer = filledBuffer(20);
  assert.equal(buffer.sample(1000 * TICK_MS).get(1)!.x, 20);
});

test('entities that appeared in the newest snapshot are drawn where they are', () => {
  const buffer = filledBuffer(20);
  buffer.push(22, new Map([...at(22), [2, { x: 5, y: 5, heading: 0 }]]), 22 * TICK_MS);
  assert.deepEqual(buffer.sample(40 * TICK_MS).get(2), { x: 5, y: 5, heading: 0 });
});
