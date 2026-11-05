import { createServer } from "node:http";
import {
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { usageSnapshot } from "./usage.mjs";
import { groupInstructions, outputInstructions } from "./instructions.mjs";
import { imageDirectory, ownedImageId } from "./visuals.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/paper.css", ["styles/paper/paper.css", "text/css; charset=utf-8"]],
]);

export function taskTiming(task) {
  const elapsed = (end, start) =>
    Number.isSafeInteger(end) && Number.isSafeInteger(start) && end >= start
      ? end - start
      : null;
  return {
    waitMs: elapsed(task.modelStartedAt, task.firstReceivedAt),
    modelMs: elapsed(task.modelCompletedAt, task.modelStartedAt),
    sendMs: elapsed(task.acceptedAt, task.sendStartedAt),
    totalMs: elapsed(task.acceptedAt, task.firstReceivedAt),
  };
}

export function debugHistory(history, directory) {
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
    imageIds: (turn.items ?? [])
      .filter((item) => item.type === "userMessage")
      .flatMap((item) =>
        (item.content ?? [])
          .filter((part) => ["localImage", "image"].includes(part.type))
          .map((part) =>
            part.type === "localImage"
              ? ownedImageId(part.path, directory)
              : null
          )
      ),
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
  const imageRoot = imageDirectory(config.stateDir);
  const allowedImages = new Set();
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
      const requestedImage = /^\/api\/image\/([a-f0-9]{64})$/.exec(
        url.pathname
      )?.[1];
      if (requestedImage) {
        snapshot();
        if (!allowedImages.has(requestedImage))
          return send(404, { error: "图片不属于已读取的群会话" });
        const fd = openSync(
          join(imageRoot, `${requestedImage}.jpg`),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        );
        let bytes;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
            throw Error("Invalid model image");
          bytes = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
        if (createHash("sha256").update(bytes).digest("hex") !== requestedImage)
          throw Error("Model image changed");
        return send(200, bytes, "image/jpeg");
      }
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
      const turns = history ? debugHistory(history, imageRoot) : [];
      for (const id of turns.flatMap((turn) => turn.imageIds).filter(Boolean))
        allowedImages.add(id);
      return send(200, {
        group,
        threadId: conversation?.threadId ?? null,
        model: config.model ?? history?.thread.model ?? null,
        updatedAt: new Date().toISOString(),
        usageSince: state.usage.since,
        turns,
        instructions: [
          groupInstructions(!!config.snap),
          outputInstructions(config.model, config.snap?.defaultRegion),
        ],
        usage:
          usageSnapshot(state).groups.find(
            (item) => item.threadId === group.id
          ) ?? null,
        limits: {
          callIntervalMs: config.callIntervalMs,
          maxCallsPerHour: config.maxCallsPerHour,
          batchWindowMs: config.batchWindowMs,
          pollIntervalMs: config.pollIntervalMs,
          replyToAssistantQuotes:
            config.groups.find((item) => item.id === group.id)
              .replyToAssistantQuotes === true,
          receiveImagesAndStickers:
            config.groups.find((item) => item.id === group.id)
              .receiveImagesAndStickers === true,
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
            timing: taskTiming(task),
            trigger: task.trigger ?? null,
            replyFallback: task.replyFallback === true,
            silenceReason: task.silenceReason ?? null,
            replySuppressed: task.replySuppressed === true,
            modelRequests: task.modelRequests ?? null,
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
