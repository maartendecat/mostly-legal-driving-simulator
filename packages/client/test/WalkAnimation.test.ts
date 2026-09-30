import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WalkAnimation } from '../src/assets/common';

const DT = 1 / 60;
const WALK_SPEED = 3; // blocks per second, as in the simulation

/** Walks east (heading 0) at `speed` for `frames` frames; returns the left foot's position each frame. */
function walk(anim: WalkAnimation, frames: number, speed = WALK_SPEED, start = 0, heading = 0): number[] {
  const feet: number[] = [];
  for (let i = 1; i <= frames; i++) {
    anim.update(DT, start + speed * DT * i, 0, heading, true);
    feet.push(anim.leftFootX);
  }
  return feet;
}

test('walking makes the feet step out in front and behind, in turn', () => {
  const anim = new WalkAnimation();
  anim.update(DT, 0, 0, 0, true);
  const feet = walk(anim, 60);
  const settled = feet.slice(20);
  assert.ok(Math.max(...settled) > 0.1, 'left foot steps forward');
  assert.ok(Math.min(...settled) < -0.1, 'and back');
});

test('the cycle follows the distance walked: 3 blocks per second is about 3.3 cycles', () => {
  const anim = new WalkAnimation();
  anim.update(DT, 0, 0, 0, true);
  const feet = walk(anim, 60).slice(10);
  const crossings = feet.filter((x, i) => i > 0 && feet[i - 1]! < 0 && x >= 0).length;
  assert.ok(crossings >= 2 && crossings <= 4, `${crossings} forward swings in 50 frames`);
});

test('standing still brings the feet back under the body', () => {
  const anim = new WalkAnimation();
  anim.update(DT, 0, 0, 0, true);
  walk(anim, 40);
  const stoppedAt = WALK_SPEED * DT * 40;
  for (let i = 0; i < 30; i++) anim.update(DT, stoppedAt, 0, 0, true);
  assert.ok(Math.abs(anim.leftFootX) < 0.01, `foot at ${anim.leftFootX}`);
});

test('walking backwards runs the cycle the other way', () => {
  const forwards = new WalkAnimation();
  const backwards = new WalkAnimation();
  forwards.update(DT, 0, 0, 0, true);
  backwards.update(DT, 0, 0, 0, true);
  const f = walk(forwards, 30);
  const b = walk(backwards, 30, -WALK_SPEED);
  for (let i = 0; i < f.length; i++) assert.ok(Math.abs(f[i]! + b[i]!) < 1e-9, `frame ${i}: ${f[i]} vs ${b[i]}`);
});

test('a teleport (respawning) is not a step, and dead peds have no feet', () => {
  const anim = new WalkAnimation();
  anim.update(DT, 0, 0, 0, true);
  anim.update(DT, 40, 12, 0, true);
  assert.equal(anim.leftFootX, 0);
  anim.update(DT, 40.05, 12, 0, false);
  assert.equal(anim.feet.visible, false);
});
