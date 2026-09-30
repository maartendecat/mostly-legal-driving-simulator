import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapAngle } from '@game/shared';
import type { Transform, TransformSnapshot } from '../src/render/transforms';
import { CorrectionSmoother } from '../src/session/CorrectionSmoother';

const at = (x: number, y = 0, heading = 0): Transform => ({ x, y, heading });
const frame = (smoother: CorrectionSmoother, t: Transform, dt: number) => {
  const transforms: TransformSnapshot = new Map([[1, t]]);
  smoother.apply(transforms, dt);
  return transforms.get(1)!;
};

test('right after a correction the car is still drawn where it was', () => {
  const smoother = new CorrectionSmoother();
  smoother.corrected(1, at(10), at(10.5));
  assert.equal(frame(smoother, at(10.5), 0).x, 10);
});

test('the correction fades out over a few frames', () => {
  const smoother = new CorrectionSmoother();
  smoother.corrected(1, at(10, 0, 0.2), at(10.5, 0, 0));
  const drawn: number[] = [];
  for (let i = 0; i < 30; i++) drawn.push(frame(smoother, at(10.5), 1 / 60).x);
  for (let i = 1; i < drawn.length; i++) assert.ok(drawn[i]! >= drawn[i - 1]!, 'moves steadily towards the corrected position');
  assert.ok(Math.abs(drawn[5]! - 10.5) > 0.1, 'not snapped after 5 frames');
  assert.ok(Math.abs(drawn.at(-1)! - 10.5) < 0.01, 'settled (to within a hundredth of a block) after half a second');
});

test('corrections add up, and wrap headings the short way round', () => {
  const smoother = new CorrectionSmoother();
  smoother.corrected(1, at(0, 0, 3.1), at(0.2, 0, -3.1));
  smoother.corrected(1, at(0.2), at(0.3));
  const t = frame(smoother, at(0.3, 0, -3.1), 0);
  assert.ok(Math.abs(t.x - 0) < 1e-9);
  // Still drawn at the old heading (3.1), reached the short way (a small turn, not almost a full one).
  assert.ok(Math.abs(wrapAngle(t.heading - 3.1)) < 1e-9, `heading ${t.heading}`);
  assert.ok(Math.abs(t.heading - -3.1) < 0.1);
});

test('real jumps like respawning are not smoothed', () => {
  const smoother = new CorrectionSmoother();
  smoother.corrected(1, at(5), at(40));
  assert.equal(frame(smoother, at(40), 0).x, 40);
});
