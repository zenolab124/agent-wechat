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
const lookupLabel = (query) => {
  if (query?.kind?.startsWith("engine_")) return ({engine_opening_test:"从开局机制测试",engine_test:"自动机制测试",engine_status:"引擎能力与格式",engine_read:"读取推演："+(query.id??""),engine_catalog:"引擎目录："+(query.query??""),engine_prepare:"准备局面核对",engine_confirm:"确认推演："+(query.id??"")})[query.kind]??query.kind;
  if (query?.kind === "recent_cards") return "按上线日期查询近期卡牌";
  if (query?.kind === "location") return `地点：${query.query ?? ""}`;
  if (query?.kind === "location_schedule")
    return `地点排期${query.query ? `：${query.query}` : ""}`;
  if (query?.kind === "rules") return `规则文档：${query.query ?? ""}`;
  if (query?.kind === "decks")
    return `卡组搜索${query.query ? `：${query.query}` : ""}${
      query.featured ? " · 天梯精选" : ""
    }${query.include?.length ? ` · 包含${query.include.join("、")}` : ""}`;
  if (query?.kind === "decode_deck") return "解析卡组码";
  if (query?.kind === "encode_image_deck") return "截图转卡组码";
  return query?.query ?? "最近 OTA";
};
function message(parent, role, text, at, sender, quote) {
  const box = el("div", undefined, `message ${role}`);
  const who = el("div", undefined, "who");
  who.append(
    el(
      "strong",
      role === "assistant" ? "助手" : role === "source" ? "SNAP 资料" : "群成员"
    ),
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
  return box;
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
        for (const row of rows) {
          const bubble = message(
            box,
            "user",
            row.text,
            row.at,
            row.sender,
            row.quote
          );
          if (row.vision) {
            const id = turn.imageIds?.[row.vision.imageIndex - 1];
            if (
              row.vision.status === "ready" &&
              typeof id === "string" &&
              /^[a-f0-9]{64}$/.test(id)
            ) {
              const image = el("img", undefined, "model-image");
              image.src = `/api/image/${id}`;
              image.alt =
                row.kind === "sticker"
                  ? "表情包的模型静态预览"
                  : "提供给模型的图片";
              image.loading = "lazy";
              bubble.append(image);
            }
            bubble.append(
              el(
                "small",
                row.vision.status === "ready"
                  ? `已提供给模型 · ${
                      row.vision.representation === "first-frame"
                        ? "动态表情首帧"
                        : row.vision.representation === "native-still-preview"
                        ? "微信静态预览"
                        : "静态图像"
                    }`
                  : `图片内容尚不可读：${row.vision.status}`
              )
            );
          }
        }
      else if (Array.isArray(input?.snapLookupResults)) {
        for (const result of input.snapLookupResults) {
          const bubble = message(
            box,
            "source",
            `${result.query?.region === "cn" ? "国服" : "国际服"} · ${
              result.query?.kind ?? "查询"
            } · ${lookupLabel(result.query)} · ${result.status}`
          );
          const details = el("details");
          details.append(
            el("summary", "查看资料、来源与时间"),
            el("pre", JSON.stringify(result, null, 2))
          );
          bubble.append(details);
        }
      } else message(box, "user", raw);
    }
    for (const raw of turn.answers) {
      let decision;
      try {
        decision = JSON.parse(raw);
      } catch {
        /* Preserve malformed final output for debugging. */
      }
      if (Array.isArray(decision?.lookup))
        box.append(
          el(
            "div",
            `助手查询 SNAP 资料：${decision.lookup
              .map(
                (item) =>
                  `${item.region === "cn" ? "国服" : "国际服"} ${lookupLabel(
                    item
                  )}`
              )
              .join("、")}`,
            "message silent"
          )
        );
      else if (decision?.reply === false)
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
  const workerState={running:'自动回复运行中',starting:'自动回复启动中',reconnecting:'自动回复连接恢复中',stopped:'自动回复已停止',stalled:'自动回复心跳超时',unknown:'自动回复状态待核对'}[data.worker?.state]??'自动回复状态待核对';
  $("subtitle").textContent += ' · '+workerState;
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
  } · ${
    data.limits.maxCallsPerHour > 0
      ? `${data.limits.maxCallsPerHour} 次/小时`
      : "无小时调用额度"
  } · ${data.limits.batchWindowMs / 1000} 秒合并`;
  if (data.limits.replyToAssistantQuotes)
    $("limits").textContent += " · 引用助手必回复";
  if (data.limits.receiveImagesAndStickers)
    $("limits").textContent +=
      " · 接收文字/图片/表情，纯表情只入上下文，过滤视频/语音/文件";
  $("polling").textContent = `${
    (data.limits.pollIntervalMs ?? 1000) / 1000
  } 秒`;
  $("usage-status").textContent = !usage
    ? "尚无统计"
    : usage.tokenUsageComplete
    ? "已上报用量完整"
    : `${usage.unknownUsageCalls} 次调用用量未知或未完成`;
  $("prompt").textContent = data.instructions.join("\n\n");
  if(data.localData) $("limits").textContent += ` · 本地卡牌 ${time(data.localData.catalogGeneratedAt)} · OTA ${time(data.localData.ota?.fetchedAt)} · 人设 ${data.persona?.name??"默认"}`;
  const tasks = document.createDocumentFragment();
  for (const task of data.tasks) {
    const row = el("div", undefined, "task");
    row.append(
      el("span", states[task.state] ?? task.state, "state"),
      document.createTextNode(` · ${task.messages} 条消息`)
    );
    if (task.silenceReason === "sticker-only")
      row.append(
        el(
          "div",
          "纯表情：只保留上下文，不发送回复" +
            (task.replySuppressed ? "（已拦截模型接话）" : "")
        )
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
    if(task.replyStyle) row.append(el("small", `回复形式：${task.replyStyle.mode === "quote" ? "原生引用" : "直接回复"} · ${task.replyStyle.reason}`));
    if (task.trigger === "image-deck-request")
      row.append(el("small", "明确请求截图转码 · @可选 · 目标图片绑定"));
    if (task.verifiedDeckCode)
      row.append(el("small", "回复中的卡组码已通过本地校验"));
    for(const timing of task.visualTimings??[])row.append(el("small",`图片${timing.messageIndex}准备 ${(timing.totalMs/1000).toFixed(2)} 秒 · 校验${timing.checksMs}ms / 媒体状态${timing.assetsMs}ms / 读取${timing.contentMs}ms / 转图${timing.normalizeMs}ms${timing.cacheHit?" · 已复用预览":""}`));
    if(task.preloadedQueries?.length)row.append(el("small",`本地预载 ${task.preloadedQueries.length} 项 · ${task.preloadMs??"?"}ms`));
    if (task.modelRequests)
      row.append(
        el("small", `实际模型请求：${task.modelRequests} 次（含资料查询阶段）`)
      );
    if (task.trigger === "assistant-quote")
      row.append(
        el(
          "small",
          task.replyFallback
            ? "引用助手触发 · 使用澄清答复"
            : "引用助手触发 · 必回复"
        )
      );
    for(const operation of task.engineOperations??[]) row.append(el("small",`${lookupLabel(operation)} · ${operation.status}${operation.version?" · "+operation.version:""}${operation.id?" · "+operation.id:""}${operation.durationMs!==null?" · 引擎计算 "+(operation.durationMs/1000).toFixed(3)+" 秒":""}${operation.reused?" · 复用结果":""}`));
    for(const operation of task.engineOperations??[]) if(operation.hypothetical||operation.failureCode) row.append(el("small",`${operation.hypothetical?"助手构造的机制测试假设":"真实对局推演"}${operation.failureCode?" · 原因分类："+operation.failureCode:""}`));
    if(task.deliveryText) {const detail=el("details");detail.append(el("summary","本轮实际发送文本"),el("pre",task.deliveryText));row.append(detail);}
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
