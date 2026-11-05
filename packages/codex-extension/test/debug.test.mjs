import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { startDebugServer, taskTiming } from "../src/debug-server.mjs";

test("missing or invalid old timing remains unknown", () => {
  assert.deepEqual(taskTiming({}), {
    waitMs: null,
    modelMs: null,
    sendMs: null,
    totalMs: null,
  });
  assert.equal(
    taskTiming({ modelStartedAt: 100, modelCompletedAt: 99 }).modelMs,
    null
  );
});

test("debug server reads only configured group history without a model turn, write operation or credential response", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wx-debug-"));
  const binding = {
    baseUrl: "http://127.0.0.1:1",
    accountId: "test-account",
    ownUsername: "bot",
  };
  const state = {
    binding,
    conversations: {
      "a@chatroom": { threadId: "thread", profile: "/isolated" },
    },
    tasks: {},
    usage: { since: new Date().toISOString(), groups: {} },
  };
  const save = () =>
    writeFileSync(join(directory, "state.json"), JSON.stringify(state));
  save();
  let reads = 0;
  const codex = {
    profile: "/isolated",
    readConversation: async (id) => {
      assert.equal(id, "thread");
      reads++;
      return {
        thread: { id },
        turns: [
          {
            id: "turn",
            status: "completed",
            items: [
              {
                type: "userMessage",
                content: [{ type: "text", text: "<script>untrusted</script>" }],
              },
              { type: "reasoning", text: "private-reasoning" },
              {
                type: "agentMessage",
                phase: "commentary",
                text: "private-commentary",
              },
              {
                type: "agentMessage",
                phase: "final_answer",
                text: '{"reply":false}',
              },
            ],
          },
        ],
      };
    },
  };
  const config = {
    ...binding,
    stateDir: directory,
    groups: [{ id: "a@chatroom" }, { id: "empty@chatroom" }],
    callIntervalMs: 30000,
    maxCallsPerHour: 6,
    batchWindowMs: 3000,
    secretToken: "must-not-expose",
  };
  const server = await startDebugServer({ config, codex, port: 0 });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/app.mjs")).status, 200);
  const groups = await (await fetch(base + "/api/groups")).json();
  const response = await fetch(
    base + "/api/conversation?group=" + groups.groups[0].key
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(reads, 1);
  assert.equal(data.turns[0].inputs[0], "<script>untrusted</script>");
  assert.equal(data.turns[0].answers[0], '{"reply":false}');
  assert.ok(!JSON.stringify(data).includes("private-reasoning"));
  assert.ok(!JSON.stringify(data).includes("private-commentary"));
  assert.ok(!JSON.stringify(data).includes("must-not-expose"));
  assert.ok(!JSON.stringify(data).includes("/isolated"));
  assert.equal(
    (await fetch(base + "/api/conversation?group=unconfigured")).status,
    404
  );
  const empty = await (
    await fetch(base + "/api/conversation?group=" + groups.groups[1].key)
  ).json();
  assert.deepEqual(empty.turns, []);
  assert.equal(reads, 1);
  assert.equal(
    (await fetch(base + "/api/groups", { method: "POST" })).status,
    405
  );
  assert.equal(
    (
      await fetch(base + "/api/groups", {
        headers: { Origin: "https://external.test" },
      })
    ).status,
    403
  );
  const reboundStatus = await new Promise((resolve, reject) => {
    get(
      base + "/api/groups",
      { headers: { Host: "external.test" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    ).on("error", reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(base + "/state.json")).status, 404);
  state.binding.ownUsername = "other";
  save();
  assert.equal((await fetch(base + "/api/groups")).status, 503);
  assert.equal(reads, 1);
});
