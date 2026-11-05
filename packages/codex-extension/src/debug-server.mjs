import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { usageSnapshot } from "./usage.mjs";
import { GROUP_INSTRUCTIONS, OUTPUT_INSTRUCTIONS } from "./instructions.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/paper.css", ["styles/paper/paper.css", "text/css; charset=utf-8"]],
]);

export function debugHistory(history) {
  return history.turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    inputs: (turn.items ?? [])
      .filter((item) => item.type === "userMessage")
      .map((item) =>
        (item.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      ),
    answers: (turn.items ?? [])
      .filter(
        (item) => item.type === "agentMessage" && item.phase === "final_answer"
      )
      .map((item) => item.text),
  }));
}

export async function startDebugServer({ config, codex, port = 16175 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("Invalid debug port");
  const groups = config.groups.map((group, index) => ({
    id: group.id,
    key: createHash("sha256").update(group.id).digest("hex").slice(0, 20),
    title: `群聊 ${String(index + 1).padStart(2, "0")}`,
  }));
  const snapshot = () => {
    const state = JSON.parse(
      readFileSync(join(config.stateDir, "state.json"), "utf8")
    );
    const binding = {
      baseUrl: config.baseUrl,
      accountId: config.accountId,
      ownUsername: config.ownUsername,
    };
    if (JSON.stringify(state.binding) !== JSON.stringify(binding))
      throw Error("Debug/account binding mismatch");
    return state;
  };
  snapshot();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );
    const send = (status, value, type = "application/json; charset=utf-8") => {
      response.writeHead(status, { "Content-Type": type });
      response.end(
        type.startsWith("application/json") ? JSON.stringify(value) : value
      );
    };
    const host = request.headers.host;
    const allowed = [
      `127.0.0.1:${server.address().port}`,
      `localhost:${server.address().port}`,
    ];
    if (
      !allowed.includes(host) ||
      (request.headers.origin && request.headers.origin !== `http://${host}`)
    )
      return send(403, { error: "仅允许本机同源访问" });
    if (request.method !== "GET")
      return send(405, { error: "此调试页只提供读取操作" });
    try {
      const url = new URL(request.url, `http://${host}`);
      if (assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        return send(
          200,
          readFileSync(new URL(`./debug-ui/${file}`, import.meta.url)),
          type
        );
      }
      if (url.pathname === "/api/groups") {
        const state = snapshot();
        return send(200, {
          groups: groups.map((group) => ({
            ...group,
            hasConversation: !!state.conversations?.[group.id],
          })),
        });
      }
      if (url.pathname !== "/api/conversation")
        return send(404, { error: "页面不存在" });
      const group = groups.find(
        (group) => group.key === url.searchParams.get("group")
      );
      if (!group) return send(404, { error: "请选择已配置的群" });
      const state = snapshot();
      const conversation = state.conversations?.[group.id];
      if (conversation && conversation.profile !== codex.profile)
        throw Error("Debug/profile binding mismatch");
      const history = conversation
        ? await codex.readConversation(conversation.threadId)
        : null;
      return send(200, {
        group,
        threadId: conversation?.threadId ?? null,
        model: config.model ?? history?.thread.model ?? null,
        updatedAt: new Date().toISOString(),
        usageSince: state.usage.since,
        turns: history ? debugHistory(history) : [],
        instructions: [GROUP_INSTRUCTIONS, OUTPUT_INSTRUCTIONS],
        usage:
          usageSnapshot(state).groups.find(
            (item) => item.threadId === group.id
          ) ?? null,
        limits: {
          callIntervalMs: config.callIntervalMs,
          maxCallsPerHour: config.maxCallsPerHour,
          batchWindowMs: config.batchWindowMs,
        },
        tasks: Object.values(state.tasks)
          .filter((task) => task.threadId === group.id)
          .slice(-30)
          .reverse()
          .map((task) => ({
            key: task.key,
            state: task.state,
            messages: task.inputs?.length ?? 1,
            receipt: task.receiptState ?? null,
            sendId: task.sendId ?? null,
            limitReason: task.limitReason ?? null,
            usageReported: task.usageReported ?? null,
          })),
      });
    } catch {
      send(503, { error: "暂时无法读取会话，保留当前页面，稍后重试" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolve);
  });
  return server;
}
