#!/usr/bin/env node
// Regression tests for the Manifest V3 Port-message keep-alive.
// Run: node scripts/test-request-keep-alive.mjs
import assert from "node:assert/strict";
import { startPortKeepAlive, REQUEST_KEEP_ALIVE_INTERVAL_MS } from "../request-keep-alive.js";

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
      assert.equal(first.done, false, "a keep-alive tick should be scheduled");
      const [id, task] = first.value;
      tasks.delete(id);
      task.fn();
      return task.delay;
    },
    get size() { return tasks.size; },
  };
}

{
  const scheduler = fakeScheduler();
  const messages = [];
  const port = { postMessage: (message) => messages.push(message) };
  const stop = startPortKeepAlive({
    getPort: () => port,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  assert.deepEqual(messages, [{ type: "KEEP_ALIVE" }], "the first Port message is immediate");
  assert.equal(scheduler.size, 1, "the next tick is scheduled");
  assert.equal(scheduler.runNext(), REQUEST_KEEP_ALIVE_INTERVAL_MS, "heartbeat uses the 20-second interval");
  assert.deepEqual(messages, [{ type: "KEEP_ALIVE" }, { type: "KEEP_ALIVE" }]);

  stop();
  stop(); // stopping is idempotent
  assert.equal(scheduler.size, 0, "stop cancels the pending timer");
  scheduler.runNext = () => { throw new Error("must not run after stop"); };
}

{
  const scheduler = fakeScheduler();
  const errors = [];
  let attempts = 0;
  const port = {
    postMessage() {
      attempts++;
      throw new Error("disconnected");
    },
  };
  const stop = startPortKeepAlive({
    getPort: () => port,
    onError: (error) => errors.push(error.message),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  assert.equal(attempts, 1, "a failed immediate message is attempted once");
  assert.deepEqual(errors, ["disconnected"], "a postMessage failure is reported to the caller");
  assert.equal(scheduler.size, 1, "a transient disconnect does not throw or stop the timer");
  scheduler.runNext();
  assert.equal(attempts, 2, "the next heartbeat is still attempted");
  assert.equal(errors.length, 2);
  stop();
  assert.equal(scheduler.size, 0);
}

{
  const scheduler = fakeScheduler();
  let attempts = 0;
  const stop = startPortKeepAlive({
    getPort: () => null,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  assert.equal(attempts, 0, "no Port is available, so no message is sent");
  assert.equal(scheduler.size, 1, "the side panel continues trying until streaming ends");
  scheduler.runNext();
  assert.equal(scheduler.size, 1);
  stop();
  assert.equal(scheduler.size, 0);
}

console.log("PASS  Port-message keep-alive lifecycle tests");
