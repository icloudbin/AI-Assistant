// request-keep-alive.js
//
// MV3 service workers are event-driven and may be terminated when idle. This
// small coordinator holds the worker active while one or more requests are in
// flight by periodically invoking a harmless extension API (or another
// extension event source). It is deliberately best-effort: callers must still
// handle worker termination, port disconnects and partial results.
//
// The timeout is scheduled only after the previous heartbeat settles. That
// prevents overlapping extension API calls if the browser or API is slow.

export const REQUEST_KEEP_ALIVE_INTERVAL_MS = 20_000;

export function createRequestKeepAlive({
  heartbeat,
  intervalMs = REQUEST_KEEP_ALIVE_INTERVAL_MS,
  onError = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (typeof heartbeat !== "function") {
    throw new TypeError("A heartbeat function is required.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number.");
  }
  if (typeof schedule !== "function" || typeof cancel !== "function") {
    throw new TypeError("schedule and cancel must be functions.");
  }

  const holds = new Set();
  let timer = null;
  let heartbeatInFlight = false;

  const scheduleNext = () => {
    if (!holds.size || timer !== null || heartbeatInFlight) return;
    timer = schedule(() => {
      timer = null;
      void runHeartbeat();
    }, intervalMs);
  };

  const runHeartbeat = async () => {
    if (!holds.size || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      await heartbeat();
    } catch (error) {
      // A failed keep-alive must not become an unhandled rejection or stop
      // later retries. The caller remains responsible for recovery if Chrome
      // nevertheless terminates the worker.
      try { onError(error); } catch {}
    } finally {
      heartbeatInFlight = false;
      scheduleNext();
    }
  };

  return {
    start() {
      const hold = Symbol("request-keep-alive");
      holds.add(hold);

      // Run immediately, rather than waiting for the first interval. This
      // covers the initial async preparation phase before the provider starts.
      if (timer === null && !heartbeatInFlight) void runHeartbeat();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds.delete(hold);
        if (holds.size === 0 && timer !== null) {
          cancel(timer);
          timer = null;
        }
      };
    },
    get activeHolds() {
      return holds.size;
    },
    get heartbeatPending() {
      return heartbeatInFlight;
    },
  };
}
