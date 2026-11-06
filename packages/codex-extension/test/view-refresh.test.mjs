import test from "node:test";
import assert from "node:assert/strict";
import { ViewRefreshQueue } from "../src/view-refresh.mjs";
test("view refresh runs outside the caller, coalesces pending groups and serializes writes while inference can continue", async () => {
  let release, entered;
  const started = new Promise((r) => (entered = r)),
    hold = new Promise((r) => (release = r)),
    calls = [];
  const q = new ViewRefreshQueue({
    delayMs: 0,
    refresh: async (g) => {
      calls.push(g);
      if (calls.length === 1) {
        entered();
        await hold;
      }
    },
  });
  q.schedule("a");
  q.schedule("a");
  const flush = q.flush();
  await started;
  q.schedule("a");
  q.schedule("a");
  q.schedule("b");
  assert.deepEqual(calls, ["a"]);
  release();
  await flush;
  assert.deepEqual(calls, ["a", "a", "b"]);
});
test("view errors and shutdown do not poison delivery or leave another scheduled refresh", async () => {
  const events = [],
    c = new AbortController();
  let calls = 0;
  const q = new ViewRefreshQueue({
    signal: c.signal,
    refresh: async () => {
      calls++;
      throw Error("view down");
    },
    report: (x) => events.push(x),
  });
  q.schedule("a");
  await q.flush();
  assert.equal(events[0].event, "context.view-unavailable");
  q.schedule("a");
  c.abort();
  await q.flush();
  assert.equal(calls, 1);
});
