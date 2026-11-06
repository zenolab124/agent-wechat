import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { NativeWeChatClient } from "@agent-wechat/shared/native-source";
import {
  reconnectingReads,
  transientReadError,
  createWorkerHealth,
  readWorkerHealth,
} from "../src/runtime.mjs";
const timeout = () =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");

test("real SDK TimeoutError 23 reconnects a read and returns its original account", async (t) => {
  let calls = 0;
  const events = [];
  const server = createServer((_req, res) => {
    if (++calls === 1) {
      setTimeout(() => {
        if (!res.destroyed) res.end("{}");
      }, 500).unref();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "same-account",
        authenticated: true,
        ownUsername: "same-bot",
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const native = new NativeWeChatClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "synthetic",
    timeoutMs: 100,
  });
  const client = reconnectingReads(native, {
    sleep: async () => {},
    report: (e) => events.push(e),
  });
  const account = await client.account("same-account");
  assert.equal(account.id, "same-account");
  assert.equal(calls, 2);
  assert.equal(events[0].error, "TimeoutError");
  assert.deepEqual(
    events.map((e) => e.event),
    ["daemon.reconnecting", "daemon.reconnected"]
  );
});

test("read retry preserves method arguments/cursor and backs off while posts and fatal errors are never retried", async () => {
  const calls = [],
    waits = [];
  let failures = 0;
  const client = reconnectingReads(
    {
      events: async (...args) => {
        calls.push(args);
        if (failures++ < 8) throw timeout();
        return { items: [] };
      },
      sendText: async () => {
        throw timeout();
      },
    },
    { sleep: async (ms) => waits.push(ms) }
  );
  await client.events("pinned-account", "78", 100);
  assert.ok(
    calls.every(
      (args) =>
        JSON.stringify(args) === JSON.stringify(["pinned-account", "78", 100])
    )
  );
  assert.deepEqual(waits, [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  assert.equal(transientReadError(timeout()), true);
  assert.equal(timeout().code, 23);
  for (const error of [
    Object.assign(Error(), {
      name: "NativeApiError",
      status: 401,
      retryable: true,
    }),
    Object.assign(Error(), {
      name: "NativeApiError",
      status: 503,
      retryable: false,
    }),
    Error("identity changed"),
    new SyntaxError("invalid JSON"),
    new TypeError("invalid input"),
  ]) {
    let tries = 0;
    const c = reconnectingReads(
      {
        account: async () => {
          tries++;
          throw error;
        },
      },
      { sleep: async () => assert.fail("must not retry") }
    );
    await assert.rejects(c.account("same"), (e) => e === error);
    assert.equal(tries, 1);
  }
  let posts = 0;
  const c = reconnectingReads(
    {
      sendText: async () => {
        posts++;
        throw timeout();
      },
    },
    { sleep: async () => assert.fail("must not retry writes") }
  );
  await assert.rejects(c.sendText("a", "g", "text", "same-key"));
  assert.equal(posts, 1);
  assert.equal(
    transientReadError(
      Object.assign(Error(), {
        name: "NativeApiError",
        status: 503,
        retryable: true,
      })
    ),
    true
  );
  assert.equal(
    transientReadError(
      Object.assign(Error(), { cause: { code: "ECONNREFUSED" } })
    ),
    true
  );
});

test("cancellation during read backoff ends recovery without another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const c = reconnectingReads(
    {
      account: async () => {
        calls++;
        throw timeout();
      },
    },
    { signal: controller.signal, sleep: async () => controller.abort() }
  );
  await assert.rejects(c.account("same"), (e) => e.name === "AbortError");
  assert.equal(calls, 1);
});

test("operational status distinguishes live worker, reconnecting, stale heartbeat and a readable debug page without worker", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wx-health-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  const h = createWorkerHealth(dir, { now: () => now, pid: 42 });
  t.after(() => h.close());
  writeFileSync(join(dir, "worker.lock"), JSON.stringify({ pid: 42 }));
  const read = () =>
    readWorkerHealth(dir, { now: () => now, alive: () => true });
  assert.equal(read().state, "starting");
  h.ready();
  assert.equal(read().state, "running");
  h.reconnecting("events", 1);
  assert.equal(read().state, "reconnecting");
  h.recovered();
  assert.equal(read().state, "running");
  now += 90001;
  assert.equal(read().state, "stalled");
  h.close();
  assert.equal(read().state, "stopped");
  assert.equal(readWorkerHealth(dir, { alive: () => false }).state, "stopped");
  rmSync(join(dir, "worker.lock"));
  assert.equal(read().state, "stopped");
  assert.ok(
    !JSON.stringify(
      JSON.parse(readFileSync(join(dir, "worker-status.json")))
    ).includes("token")
  );
});
