import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRequestQueue } from '../src/recognition/modelRequestQueue';

test('all reading roles share the same active-call bound and release slots after failure', async () => {
  const queue = createModelRequestQueue(3, new AbortController().signal);
  let active = 0, peak = 0;
  const result = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => queue(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5)); active--;
    if (i === 2) throw new Error('upstream failure');
    return i;
  })));
  assert.equal(peak, 3); assert.equal(active, 0);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 11);
});

test('abort removes queued work without launching extra provider requests', async () => {
  const controller = new AbortController(), queue = createModelRequestQueue(1, controller.signal);
  let release!: () => void, calls = 0;
  const first = queue(async () => { calls++; await new Promise<void>(r => { release = r; }); });
  await Promise.resolve();
  const second = queue(async () => { calls++; });
  const assertion = assert.rejects(second, /cancelled/);
  controller.abort(new Error('cancelled')); await assertion; release(); await first;
  assert.equal(calls, 1);
  await assert.rejects(queue(async () => {}), /cancelled/);
});
