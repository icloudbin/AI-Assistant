#!/usr/bin/env node
// Unit tests for request-keep-alive.js. Run: node scripts/test-request-keep-alive.mjs
import assert from "node:assert/strict";
import { createRequestKeepAlive } from "../request-keep-alive.js";

function fakeScheduler() {
  let nextId = 1;
  const tasks = new Map();
  return {
    schedule(fn, delay) {
      const id = nextId++;
      tasks.set(id, { fn, delay });
      return id;
    },
    cancel(id) {
      tasks.delete(id);
    },
    runNext() {
      const first = tasks.entries().next();
      assert.equal(first.done, false, "a scheduled heartbeat should exist");
      const [id, task] = first.value;
      tasks.delete(id);
      task.fn();
      return task.delay;
    },
    get size() { return tasks.size; },
  };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

{
  const scheduler = fakeScheduler();
  let calls = 0;
  const first = createRequestKeepAlive({
    heartbeat: async () => { calls++; },
    intervalMs: 20_000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  const releaseA = first.start();
  await settle();
  assert.equal(calls, 1, "first hold runs an immediate heartbeat");
  assert.equal(scheduler.size, 1, "next heartbeat is scheduled after completion");

  const releaseB = first.start();
  assert.equal(first.activeHolds, 2, "independent requests hold the shared worker");
  releaseA();
  releaseA(); // release is idempotent
  assert.equal(first.activeHolds, 1, "one request cannot release another request's hold");
  assert.equal(scheduler.size, 1, "timer remains while any request is active");

  assert.equal(scheduler.runNext(), 20_000, "heartbeat uses the configured interval");
  await settle();
  assert.equal(calls, 2, "the next heartbeat runs once");
  releaseB();
  assert.equal(first.activeHolds, 0);
  assert.equal(scheduler.size, 0, "the last release cancels the pending timer");
}

{
  const scheduler = fakeScheduler();
  let resolveHeartbeat;
  let calls = 0;
  const keeper = createRequestKeepAlive({
    heartbeat: () => {
      calls++;
      return new Promise((resolve) => { resolveHeartbeat = resolve; });
    },
    intervalMs: 10,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  const releaseA = keeper.start();
  const releaseB = keeper.start();
  assert.equal(calls, 1, "concurrent holds do not start overlapping heartbeats");
  assert.equal(keeper.heartbeatPending, true);
  resolveHeartbeat();
  await settle();
  assert.equal(scheduler.size, 1, "the next tick is scheduled after the pending heartbeat settles");
  releaseA();
  releaseB();
  assert.equal(scheduler.size, 0);
}

{
  const scheduler = fakeScheduler();
  let attempts = 0;
  const errors = [];
  const keeper = createRequestKeepAlive({
    heartbeat: async () => {
      attempts++;
      throw new Error("temporary API failure");
    },
    onError: (error) => errors.push(error.message),
    intervalMs: 5,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  const release = keeper.start();
  await settle();
  assert.equal(attempts, 1);
  assert.deepEqual(errors, ["temporary API failure"]);
  assert.equal(scheduler.size, 1, "a failed heartbeat still schedules a retry");
  scheduler.runNext();
  await settle();
  assert.equal(attempts, 2, "heartbeat retries after a transient failure");
  assert.equal(errors.length, 2);
  release();
  assert.equal(scheduler.size, 0);
}

console.log("PASS  request keep-alive lifecycle tests");
