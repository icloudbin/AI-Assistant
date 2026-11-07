// request-keep-alive.js
//
// A Manifest V3 service worker's idle timer is reset when a message is sent
// through a long-lived extension Port (Chrome 114+). The side panel owns this
// timer and sends a lightweight message while an ASK is active. Merely opening
// a Port is not sufficient, and this is still best-effort: the panel handles
// worker/port disconnects and preserves partial output as a separate fallback.

export const REQUEST_KEEP_ALIVE_INTERVAL_MS = 20_000;

/**
 * Keep the receiving extension service worker active by sending Port messages.
 * The returned stop function is idempotent and should be called as soon as the
 * request reaches DONE, ERROR or STOP.
 */
export function startPortKeepAlive({
  getPort,
  intervalMs = REQUEST_KEEP_ALIVE_INTERVAL_MS,
  onError = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (typeof getPort !== "function") {
    throw new TypeError("getPort must be a function.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number.");
  }
  if (typeof schedule !== "function" || typeof cancel !== "function") {
    throw new TypeError("schedule and cancel must be functions.");
  }

  let stopped = false;
  let timer = null;

  const tick = () => {
    if (stopped) return;

    try {
      const port = getPort();
      if (port) port.postMessage({ type: "KEEP_ALIVE" });
    } catch (error) {
      // A stale/disconnected Port must not break the side panel's request
      // lifecycle. Continue trying until setStreaming(false) releases us.
      try { onError(error); } catch {}
    }

    if (!stopped) timer = schedule(tick, intervalMs);
  };

  // Send immediately, then schedule the next message. A recursive timeout
  // avoids an unbounded backlog if the host scheduler runs late.
  tick();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };
}
