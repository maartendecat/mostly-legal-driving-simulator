import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrowPosition, orbitRadius } from '../src/ui/PlayerArrows';

const W = 800;
const H = 600;
const M = 40;

test('arrows circle the character at the orbit radius, in the direction of their target', () => {
  assert.deepEqual(arrowPosition(400, 300, 1, 0, 120, W, H, M), { x: 520, y: 300 });
  assert.deepEqual(arrowPosition(400, 300, 0, -3, 120, W, H, M), { x: 400, y: 180 });
  const diagonal = arrowPosition(400, 300, 1, 1, 120, W, H, M);
  assert.ok(Math.abs(Math.hypot(diagonal.x - 400, diagonal.y - 300) - 120) < 1e-9);
});

test('an arrow is pulled back on screen when our character is near an edge', () => {
  assert.deepEqual(arrowPosition(760, 300, 1, 0, 120, W, H, M), { x: W - M, y: 300 });
  for (let i = 0; i < 360; i++) {
    const a = (i / 180) * Math.PI;
    const p = arrowPosition((i * 37) % W, (i * 53) % H, Math.cos(a), Math.sin(a), 150, W, H, M);
    assert.ok(p.x >= M && p.x <= W - M && p.y >= M && p.y <= H - M, JSON.stringify(p));
  }
});

test('the orbit scales with the screen, within limits', () => {
  assert.equal(orbitRadius(800, 600), 120);
  assert.equal(orbitRadius(300, 200), 80);
  assert.equal(orbitRadius(3000, 2000), 150);
});
