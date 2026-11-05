const $ = (id) => document.getElementById(id);
let selected,
  current,
  fingerprint,
  requestSequence = 0,
  loading = false;
const format = (value) =>
  Number.isSafeInteger(value) ? value.toLocaleString("zh-CN") : "—";
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const states = {
  done: "已完成",
  ignored: "未回复",
  "rate-limited": "前置限流",
  pending: "等待合并",
  sealed: "等待调用",
  generating: "生成中",
  prepared: "待发送",
  submitted: "等待回执",
  unknown: "发送待核对",
  "generation-failed": "生成失败",
  "generation-unknown": "生成结果待核对",
  failed: "发送失败",
  "dry-run": "仅本机生成",
};
const time = (value) => {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("zh-CN", { hour12: false })
    : "";
};
function message(parent, role, text, at, sender, quote) {
  const box = el("div", undefined, `message ${role}`);
  const who = el("div", undefined, "who");
  who.append(
    el("strong", role === "assistant" ? "助手" : "群成员"),
    document.createTextNode(`  ${time(at)}${sender ? ` · ${sender}` : ""}`)
  );
  box.append(who);
  if (quote)
    box.append(
      el(
        "blockquote",
        `引用 ${quote.sender ?? ""}\n${quote.text || "引用内容没有可用文字"}`,
        "quote"
      )
    );
  box.append(el("div", text, "body"));
  parent.append(box);
}
function renderTurns() {
  if (!current) return;
  const open = new Set(
    [...document.querySelectorAll(".raw[open]")].map(
      (node) => node.dataset.turn
    )
  );
  const query = $("search").value.trim().toLocaleLowerCase();
  const fragment = document.createDocumentFragment();
  let shown = 0;
  for (const [index, turn] of current.turns.entries()) {
    if (query && !JSON.stringify(turn).toLocaleLowerCase().includes(query))
      continue;
    shown++;
    const box = el("article", undefined, "turn");
    box.append(
      el(
        "div",
        `第 ${index + 1} 轮 · ${
          turn.status === "completed" ? "已完成" : turn.status
        }`,
        "turn-label"
      )
    );
    for (const raw of turn.inputs) {
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        /* Non-bridge input remains visible verbatim. */
      }
      const rows = input?.messages;
      if (Array.isArray(rows))
        for (const row of rows)
          message(box, "user", row.text, row.at, row.sender, row.quote);
      else message(box, "user", raw);
    }
    for (const raw of turn.answers) {
      let decision;
      try {
        decision = JSON.parse(raw);
      } catch {
        /* Preserve malformed final output for debugging. */
      }
      if (decision?.reply === false)
        box.append(el("div", "助手选择保持沉默", "message silent"));
      else
        message(
          box,
          "assistant",
          decision?.reply === true && typeof decision.text === "string"
            ? decision.text
            : raw
        );
    }
    if (!turn.answers.length) box.append(el("p", "本轮尚无最终答复", "muted"));
    const detail = el("details", undefined, "raw");
    detail.dataset.turn = turn.id;
    detail.open = open.has(turn.id);
    detail.append(
      el("summary", "展开本轮原始输入与输出"),
      el(
        "pre",
        JSON.stringify(
          { turnId: turn.id, inputs: turn.inputs, answers: turn.answers },
          null,
          2
        )
      )
    );
    box.append(detail);
    fragment.append(box);
  }
  if (!shown)
    fragment.append(
      el(
        "p",
        query
          ? "没有找到匹配的消息"
          : "尚无会话记录。收到首条获准消息后会在这里显示。",
        "empty"
      )
    );
  $("turns").replaceChildren(fragment);
  $("turn-count").textContent = `${current.turns.length} 轮`;
}
function render(data) {
  current = data;
  $("title").textContent = `${data.group.title} · 会话记录`;
  $("subtitle").textContent = `${data.group.id} · 长期会话 · 只读查看`;
  const usage = data.usage,
    tokens = usage?.reportedTokens;
  $("total").textContent = format(tokens?.totalTokens);
  $("blocked").textContent = usage
    ? `${usage.rateLimitedBatches} 批 / ${usage.rateLimitedMessages} 条消息`
    : "—";
  $("usage-since").textContent = time(data.usageSince);
  $("input").textContent = format(tokens?.inputTokens);
  $("cached").textContent = format(tokens?.cachedInputTokens);
  $("output").textContent = format(tokens?.outputTokens);
  $("calls").textContent = usage
    ? `${format(usage.callsStarted)} / ${format(usage.repliesAccepted)}`
    : "—";
  $("model").textContent = data.model ?? "使用配置默认模型";
  $("thread").textContent = data.threadId ?? "等待首条消息建立";
  $("limits").textContent = `${
    data.limits.callIntervalMs === 0
      ? "无固定调用间隔"
      : `${data.limits.callIntervalMs / 1000} 秒间隔`
  } · ${data.limits.maxCallsPerHour} 次/小时 · ${
    data.limits.batchWindowMs / 1000
  } 秒合并`;
  if (data.limits.replyToAssistantQuotes)
    $("limits").textContent += " · 引用助手必回复，免普通接话配额拦截";
  $("polling").textContent = `${
    (data.limits.pollIntervalMs ?? 1000) / 1000
  } 秒`;
  $("usage-status").textContent = !usage
    ? "尚无统计"
    : usage.tokenUsageComplete
    ? "已上报用量完整"
    : `${usage.unknownUsageCalls} 次调用用量未知或未完成`;
  $("prompt").textContent = data.instructions.join("\n\n");
  const tasks = document.createDocumentFragment();
  for (const task of data.tasks) {
    const row = el("div", undefined, "task");
    row.append(
      el("span", states[task.state] ?? task.state, "state"),
      document.createTextNode(` · ${task.messages} 条消息`)
    );
    row.append(
      el(
        "small",
        `回执：${task.receipt ?? "尚无"}${
          task.limitReason ? ` · ${task.limitReason}` : ""
        }`
      )
    );
    if (task.sendId) row.append(el("small", `发送 ID：${task.sendId}`));
    if (task.trigger === "assistant-quote")
      row.append(
        el(
          "small",
          task.replyFallback
            ? "引用助手触发 · 使用澄清答复"
            : "引用助手触发 · 必回复"
        )
      );
    const stages = [
      ["waitMs", "等待"],
      ["modelMs", "模型调用"],
      ["sendMs", "发送确认"],
      ["totalMs", "本机接收至确认"],
    ];
    const timing = stages
      .filter(([key]) => Number.isFinite(task.timing?.[key]))
      .map(
        ([key, label]) => `${label} ${(task.timing[key] / 1000).toFixed(2)} 秒`
      );
    row.append(
      el("small", timing.length ? timing.join(" · ") : "耗时：旧任务未采集")
    );
    tasks.append(row);
  }
  if (!data.tasks.length) tasks.append(el("p", "暂无任务", "muted"));
  $("tasks").replaceChildren(tasks);
  renderTurns();
}
async function refresh() {
  if (!selected || loading) return;
  loading = true;
  const group = selected;
  const sequence = ++requestSequence;
  try {
    const response = await fetch(
      `/api/conversation?group=${encodeURIComponent(selected)}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    if (sequence !== requestSequence || group !== selected) return;
    if (!response.ok) throw Error(data.error ?? "读取失败");
    const next = JSON.stringify({ ...data, updatedAt: null });
    if (next !== fingerprint) {
      render(data);
      fingerprint = next;
    }
    $("sync").textContent = `已同步 ${new Date(
      data.updatedAt
    ).toLocaleTimeString("zh-CN", { hour12: false })}`;
    $("error").hidden = true;
  } catch (error) {
    if (sequence === requestSequence && group === selected) {
      $("error").textContent = error.message;
      $("error").hidden = false;
      $("sync").textContent = "刷新失败";
    }
  } finally {
    loading = false;
    if (group !== selected) refresh();
  }
}
$("refresh").addEventListener("click", refresh);
$("search").addEventListener("input", renderTurns);
$("latest").addEventListener("click", () =>
  $("turns").lastElementChild?.scrollIntoView({
    behavior: "smooth",
    block: "end",
  })
);
let dark = matchMedia("(prefers-color-scheme: dark)").matches;
const setTheme = () => {
  document.documentElement.classList.toggle("dark", dark);
  $("theme").setAttribute("aria-pressed", String(dark));
};
setTheme();
$("theme").addEventListener("click", () => {
  dark = !dark;
  setTheme();
});
try {
  const response = await fetch("/api/groups", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  for (const group of data.groups) {
    const button = el("button", undefined, "group");
    button.append(el("strong", group.title), el("small", group.id));
    button.addEventListener("click", () => {
      selected = group.key;
      fingerprint = null;
      current = null;
      $("search").value = "";
      $("turns").replaceChildren(el("p", "正在读取会话…", "empty"));
      for (const sibling of $("groups").children)
        sibling.classList.toggle("active", sibling === button);
      refresh();
    });
    $("groups").append(button);
  }
  $("groups").firstElementChild?.click();
  if (!data.groups.length)
    $("turns").append(el("p", "当前没有配置测试群", "empty"));
} catch (error) {
  $("error").textContent = error.message;
  $("error").hidden = false;
}
setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
