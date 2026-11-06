import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const reads = new Set([
  "account",
  "events",
  "message",
  "messages",
  "send",
  "sendByKey",
]);
const transientCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
export function transientReadError(error) {
  if (error?.name === "NativeApiError")
    return (
      error.retryable === true &&
      [408, 429, 500, 502, 503, 504].includes(error.status)
    );
  return (
    error?.name === "TimeoutError" ||
    transientCodes.has(error?.code) ||
    transientCodes.has(error?.cause?.code)
  );
}

// Only these GET helpers reconnect. Never wrap sends, media submissions or any
// write: their uncertain outcomes stay in the existing receipt journal.
export function reconnectingReads(
  client,
  { signal, sleep = delay, report = () => {}, health } = {}
) {
  return new Proxy(client, {
    get(target, name) {
      const method = target[name];
      if (typeof method !== "function") return method;
      if (!reads.has(name)) return method.bind(target);
      return async (...args) => {
        let failures = 0;
        while (true) {
          signal?.throwIfAborted();
          try {
            const result = await method.apply(target, args);
            signal?.throwIfAborted();
            if (failures) {
              health?.recovered();
              report({ event: "daemon.reconnected", operation: name });
            }
            return result;
          } catch (error) {
            if (signal?.aborted || !transientReadError(error)) throw error;
            const retryInMs = Math.min(
              5000,
              250 * 2 ** Math.min(failures++, 5)
            );
            health?.reconnecting(name, failures);
            if (failures === 1)
              report({
                event: "daemon.reconnecting",
                operation: name,
                error: error.name,
              });
            await sleep(retryInMs, undefined, { signal });
          }
        }
      };
    },
  });
}

// Operational liveness only: no messages, credentials or model context.
export function createWorkerHealth(
  directory,
  { now = Date.now, pid = process.pid } = {}
) {
  let ready = false,
    closed = false;
  let status = { schemaVersion: 1, pid, state: "starting", startedAt: now() };
  const write = () => {
    const temp = join(directory, ".worker-status-" + randomUUID());
    if (closed) return;
    try {
      writeFileSync(temp, JSON.stringify({ ...status, updatedAt: now() }), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, join(directory, "worker-status.json"));
    } catch {
      // A missing heartbeat must show as unknown/stale in the viewer; it must
      // not throw from a timer or prevent the reply journal lock being freed.
      try {
        rmSync(temp, { force: true });
      } catch {}
    }
  };
  write();
  const heartbeat = setInterval(write, 30000);
  heartbeat.unref();
  return {
    ready() {
      ready = true;
      status = { ...status, state: "running", operation: null, failures: 0 };
      write();
    },
    reconnecting(operation, failures) {
      status = { ...status, state: "reconnecting", operation, failures };
      write();
    },
    recovered() {
      status = {
        ...status,
        state: ready ? "running" : "starting",
        operation: null,
        failures: 0,
      };
      write();
    },
    close() {
      if (closed) return;
      clearInterval(heartbeat);
      status = { ...status, state: "stopped" };
      write();
      closed = true;
    },
  };
}

export function readWorkerHealth(
  directory,
  {
    now = Date.now,
    alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  } = {}
) {
  let lock, status;
  try {
    lock = JSON.parse(readFileSync(join(directory, "worker.lock")));
  } catch {
    return { state: "stopped", updatedAt: null };
  }
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 1 || !alive(lock.pid))
    return { state: "stopped", updatedAt: null };
  try {
    status = JSON.parse(readFileSync(join(directory, "worker-status.json")));
  } catch {
    return { state: "unknown", updatedAt: null };
  }
  if (
    status.schemaVersion !== 1 ||
    status.pid !== lock.pid ||
    !Number.isSafeInteger(status.updatedAt)
  )
    return { state: "unknown", updatedAt: null };
  if (now() - status.updatedAt > 90000 || status.updatedAt > now() + 1000)
    return { state: "stalled", updatedAt: status.updatedAt };
  return {
    state: ["starting", "running", "reconnecting", "stopped"].includes(
      status.state
    )
      ? status.state
      : "unknown",
    updatedAt: status.updatedAt,
    operation: reads.has(status.operation) ? status.operation : null,
  };
}
