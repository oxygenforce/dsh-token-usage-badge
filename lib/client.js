/**
 * dsh-token-usage-badge — 客户端半边
 *
 * 在每条已完成回答的官方动作行（复制/赞踩/分支图标 + 结束时间）末尾，追加常驻读数：
 *
 *     [复制][赞踩][…]  20:10  8.6K tok · 42秒
 *
 * 并在回答正文与这一行之间画一条 1px 的淡色分隔线（跟随主题边框色，低透明度）。
 *
 * 数据来源（都是宿主已经算好、随快照发布的值，本插件不订阅会话事件也不重放日志）：
 *   · Token：TurnLocation.data 里 `turn-tail` 节点发布的 `tokenUsage`
 *            （TurnTokenUsage：uncachedInputTokens / outputTokens / totalTokens / cache* / reasoning）；
 *            窗口化历史里该节点可能缺席，此时退回 closing.usage 的采样用量。
 *   · 耗时：turn/start 事件 → closing assistant/message 事件的时间差（Unix epoch ms）。
 *
 * 渲染位置：`conversation.chat.turnTail` 列表座位（每条已完成回合一次，位于回答正文与官方
 * 复制/分支图标行之间）。官方只在 hover 时隐藏图标行（.actions），tail 区常驻可见，
 * 所以这行读数无需悬停即可看到；鼠标悬停时通过 title 给出精确分解。
 *
 * 另外，本插件接管回答生成时的滚动姿态：官方一路跟随到底部（读者永远落在最新一行），
 * 这里改成回答第一行一出现就把它钉在视口顶部，正文继续在下方生成；读者自己滚轮 / 触摸 /
 * 键盘滚动就把控制权交还，本轮不再抢，回合结束后再钉 2 秒吸收折叠动画即放手。
 */

window.__ModuleLoader__.load({
  id: "dsh-token-usage-badge",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const ReactDOM = (() => {
      try {
        return require("react-dom");
      } catch {
        return null;
      }
    })();

    const NS = "dsh-token-usage-badge";
    const SLOT = "conversation.chat.turnTail";
    const ENTRY_ID = "dsh-token-usage-badge";
    const ORDER = -10;

    const TOKEN_BASE = 1000;
    const TOKEN_BASE_SQUARED = 1000000;

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 占位符是宿主 locale 的插值语法；tok 与官方 TurnUsage 芯片保持同一缩写。
    const MESSAGES_ZH = {
      "tokens": "{count} tok",
      "durationSeconds": "{seconds}秒",
      "durationMinutes": "{minutes}分{seconds}秒",
      "tooltipTitle": "本轮用量",
      "tooltipTotal": "总计 {total} tok",
      "tooltipInput": "未缓存输入 {count}",
      "tooltipCacheRead": "缓存读取 {count}",
      "tooltipCacheWrite": "缓存写入 {count}",
      "tooltipOutput": "输出 {count}",
      "tooltipReasoning": "（其中推理 {count}）",
      "tooltipDuration": "回答耗时 {duration}",
      "ariaTokens": "本轮 Token 用量 {tokens}",
      "ariaDuration": "回答耗时 {duration}",
      "sessionTotal": "共 {count} tok",
      "tooltipSession": "本会话累计 {total} tok",
      "ariaSession": "本会话累计 {tokens}",
      "listSeparator": "，",
    };

    const MESSAGES_EN = {
      "tokens": "{count} tok",
      "durationSeconds": "{seconds}s",
      "durationMinutes": "{minutes}m {seconds}s",
      "tooltipTitle": "Turn usage",
      "tooltipTotal": "Total {total} tok",
      "tooltipInput": "Uncached input {count}",
      "tooltipCacheRead": "Cached input {count}",
      "tooltipCacheWrite": "Cache write {count}",
      "tooltipOutput": "Output {count}",
      "tooltipReasoning": " ({count} reasoning)",
      "tooltipDuration": "Answer duration {duration}",
      "ariaTokens": "Token usage this turn {tokens}",
      "ariaDuration": "Answer duration {duration}",
      "sessionTotal": "{count} tok total",
      "tooltipSession": "Session total {total} tok",
      "ariaSession": "Session total {tokens}",
      "listSeparator": ", ",
    };

    /** 极简兜底插值：只在宿主没有把 t 注入到组件 props 时使用。 */
    function interpolate(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      ));
    }

    function makeDictionary(dictionary) {
      return function t(key, params) {
        const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
        return interpolate(template, params);
      };
    }

    const fallbackT = makeDictionary(MESSAGES_ZH);

    // ── 数值 ────────────────────────────────────────────────────────────────

    /** 非负有限数；其它（undefined / null / NaN / 负数）返回 undefined。 */
    function count(value) {
      const numeric = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
      return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
    }

    /** 紧凑读数，与官方数字族同构：8.6K / 120K / 1.2M。 */
    function compactCount(value) {
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
      if (value < TOKEN_BASE) return String(Math.round(value));
      if (value < TOKEN_BASE_SQUARED) return `${scaled(value / TOKEN_BASE)}K`;
      return `${scaled(value / TOKEN_BASE_SQUARED)}M`;
    }

    /** 精确读数：千位分组，给 title 用。 */
    function exactCount(value) {
      const digits = String(Math.round(value));
      const groups = [];
      for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
      return groups.join(",");
    }

    /** 耗时读数：<10s 保留一位小数，<60s 取整，更长走 分+秒。 */
    function formatDuration(ms, t) {
      const seconds = ms / 1000;
      if (seconds < 9.95) return t("durationSeconds", { seconds: String(Math.round(seconds * 10) / 10) });
      if (seconds < 59.5) return t("durationSeconds", { seconds: String(Math.round(seconds)) });
      const whole = Math.round(seconds);
      const minutes = Math.floor(whole / 60);
      const rest = whole % 60;
      return t("durationMinutes", { minutes: String(minutes), seconds: rest < 10 ? `0${rest}` : String(rest) });
    }

    // ── 数据提取 ────────────────────────────────────────────────────────────

    function readTurnTail(turn) {
      try {
        const data = turn?.data;
        if (!data || typeof data.get !== "function") return undefined;
        return data.get("turn-tail");
      } catch {
        return undefined;
      }
    }

    /**
     * 归一化一轮的 Token 用量。
     * 优先 turn-tail 节点上的 TurnTokenUsage；缺席时退回 closing assistant 的采样 usage。
     * 总量为 0 或全无字段时返回 null（不显示无意义的 0 tok）。
     */
    function readUsage(tail) {
      if (tail === null || typeof tail !== "object") return null;
      const direct = tail.tokenUsage;
      if (direct && typeof direct === "object") {
        const normalized = normalizeTokens(direct, false);
        if (normalized !== null) return normalized;
      }
      const sampled = tail.closing && typeof tail.closing === "object" ? tail.closing.usage : undefined;
      if (sampled && typeof sampled === "object") return normalizeTokens(sampled, true);
      return null;
    }

    function normalizeTokens(raw, sampled) {
      const input = sampled ? (count(raw.inputTokens) ?? count(raw.uncachedInputTokens)) : count(raw.uncachedInputTokens);
      const cacheRead = count(raw.cacheReadTokens);
      const cacheWrite = count(raw.cacheWriteTokens);
      const output = count(raw.outputTokens);
      const reasoning = count(raw.reasoningTokens);
      const knownTotal = count(raw.totalTokens);
      const total = knownTotal ?? ((input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (output ?? 0));
      if (!(total > 0)) return null;
      return { total, input, cacheRead, cacheWrite, output, reasoning };
    }

    /** 一轮的墙钟耗时（毫秒）。起点缺席（窗口化历史）时退回首个 step/start。 */
    function readDurationMs(turn, tail) {
      try {
        const start = count(turn?.start?.time) ?? count(turn?.steps?.[0]?.start?.time);
        const end = count(tail?.closing?.time) ?? count(turn?.end?.time);
        if (start === undefined || end === undefined) return null;
        const ms = end - start;
        return ms > 0 ? ms : null;
      } catch {
        return null;
      }
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    // 官方动作行容器自身带 data-clock="end"（MessageIconActions 的根 div）；
    // 往它的末端 portal，读数就落在“20:10”这类结束时间之后，与图标行同排。
    const ACTIONS_ROW_SELECTOR = '[data-clock="end"]';

    /**
     * 横线视觉居中：找到正文块（上一段 flow item）的底边，把它到线的距离
     * 和线到动作行的距离拉平。用 transform 位移，不写 margin —— 布局高度不变，
     * 新回答流式渲染时不会引起滚动位置跳动。
     */
    // 横线位置：固定贴在官方图标行上方 RULE_GAP 像素。
    // 不再“取上下空白的中点”——动作行上方会插进官方的“已完成，用时 Xs”折叠行，
    // 用中点算会把线顶得太高。这里改用图标行作为唯一基准，位置稳定可预期。
    const RULE_GAP = 15;

    function centerRule(rule, tailRoot, actionsRow) {
      if (rule === null || actionsRow === null) return;
      try {
        // 先清掉上一次的位移再量，避免量到“已经位移过”的位置反复漂移。
        rule.style.transform = "";
        const ruleRect = rule.getBoundingClientRect();
        const rowRect = actionsRow.getBoundingClientRect();
        const targetTop = rowRect.top - RULE_GAP;
        const delta = Math.round(targetTop - ruleRect.top);
        if (!Number.isFinite(delta)) return;
        rule.style.transform = delta === 0 ? "" : `translateY(${Math.max(-60, Math.min(60, delta))}px)`;
      } catch {
        /* 布局异常时保留样式表里的兜底位置 */
      }
    }

    // ── 跟随底部 ────────────────────────────────────────────────────────────
    // 宿主在“读者自己滚动过”之后会停止跟随并记住阅读位置；个别时候新指令已经出现，
    // 视图却仍停在上一屏，新回答就落到屏幕外。这里只在「新指令出现」这一个时刻检查：
    // 如果离底部还有明显距离，就补一次贴底（不改变宿主自己的跟随策略）。
    function scrollHostAncestor(node) {
      let el = node;
      while (el !== null && el !== document.body) {
        const style = getComputedStyle(el);
        const scrollable = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        if (scrollable) return el;
        el = el.parentElement;
      }
      return null;
    }

    function stickToBottomOnNewInstruction() {
      const follow = () => {
        try {
          const row = document.querySelector("[data-chat-flow-kind='user']");
          if (row === null) return;
          const scroller = scrollHostAncestor(row);
          if (scroller === null) return;
          const floor = scroller.scrollHeight - scroller.clientHeight;
          // 小于 40px 视为“本来就贴底”，不做任何事，避免和宿主的平滑滚动抢位置。
          if (floor - scroller.scrollTop <= 40) return;
          scroller.scrollTop = floor;
        } catch { /* ignore */ }
      };
      let observer = null;
      try {
        observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1) continue;
              if (node.matches?.("[data-chat-flow-kind='user']") === true) {
                requestAnimationFrame(() => setTimeout(follow, 120));
              }
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      } catch { /* ignore */ }
      return () => observer?.disconnect();
    }

    function TurnMetrics(props) {
      const t = typeof props?.t === "function" ? props.t : fallbackT;
      // 会话累计用量：宿主提供的 tokenUsage 会话投影（整条日志的 token 总和），
      // 随流式生成实时变化。hook 顺序稳定（typeof 取决于固定的 props 形状）。
      const useProjection = typeof props?.useProjection === "function" ? props.useProjection : null;
      const sessionUsage = useProjection === null ? undefined : useProjection("tokenUsage");
      let layout = null;
      try {
        layout = buildLayout(props, t, sessionUsage);
      } catch {
        layout = null;
      }

      // 先无条件调用 hooks，再决定是否渲染：同一回合内数据可能从无到有，
      // 条件式跳过 hooks 会破坏 hook 顺序。
      const hasData = layout !== null;
      const anchorRef = React.useRef(null);
      const ruleRef = React.useRef(null);
      const [row, setRow] = React.useState(null);

      React.useEffect(() => {
        pushSessionTotal(sessionTotalOf(sessionUsage));
      }, [sessionUsage]);

      React.useEffect(() => {
        if (!hasData) return;
        const anchor = anchorRef.current;
        if (!anchor || typeof anchor.closest !== "function") return;
        const tailRoot = anchor.closest("[data-turn-tail]");
        const actionsRow = tailRoot === null ? null : tailRoot.querySelector(ACTIONS_ROW_SELECTOR);
        if (actionsRow !== null) setRow(actionsRow);
      }, [hasData]);
      // 会话总量变化后标题/aria 里的大数也要跟着走，这里不额外建 effect。

      React.useEffect(() => {
        if (row === null) return;
        const tailRoot = row.closest("[data-turn-tail]");
        centerRule(ruleRef.current, tailRoot, row);
        // 聊天区有 .16s 的间距过渡，挂载瞬间量到的可能还是动画中间值，
        // 过渡结束后再量一次；只改 transform，不会引起排版跳动。
        const settle = setTimeout(() => centerRule(ruleRef.current, tailRoot, row), 260);
        return () => clearTimeout(settle);
      }, [row]);

      if (!hasData) return null;

      const metrics = h(
        "span",
        {
          className: "dtc-metrics",
          "data-dsh-token-usage-badge": "",
          "data-dtc-owner": "",
          role: "group",
          "aria-label": layout.ariaLabel,
          title: layout.title,
        },
        layout.children,
      );

      const ported = row !== null && ReactDOM !== null && typeof ReactDOM.createPortal === "function"
        ? ReactDOM.createPortal(metrics, row)
        : null;

      return h(
        React.Fragment,
        null,
        h("div", { className: "dtc-rule", ref: ruleRef, role: "separator", "aria-hidden": "true", "data-dtc-owner": "" }),
        h(
          "span",
          {
            ref: anchorRef,
            className: "dtc-anchor",
            style: ported === null ? undefined : { display: "none" },
          },
          ported === null ? metrics : ported,
        ),
      );
    }

    function sessionTotalOf(sessionUsage) {
      if (sessionUsage === undefined || sessionUsage === null || typeof sessionUsage !== "object") return undefined;
      const input = count(sessionUsage.uncachedInputTokens) ?? 0;
      const read = count(sessionUsage.cacheReadTokens) ?? 0;
      const write = count(sessionUsage.cacheWriteTokens) ?? 0;
      const output = count(sessionUsage.outputTokens) ?? 0;
      const total = input + read + write + output;
      return total > 0 ? total : undefined;
    }

    function buildLayout(props, t, sessionUsage) {
      const turn = props?.turn;
      if (turn === undefined || turn === null) return null;

      const tail = readTurnTail(turn);
      const usage = readUsage(tail);
      const durationMs = readDurationMs(turn, tail);
      if (usage === null && durationMs === null) return null;

      const tokenLabel = usage === null ? null : t("tokens", { count: compactCount(usage.total) });
      const durationLabel = durationMs === null ? null : formatDuration(durationMs, t);
      const sessionTotal = sessionTotalOf(sessionUsage);
      const sessionLabel = sessionTotal === undefined ? null : t("sessionTotal", { count: compactCount(sessionTotal) });

      const children = [];
      if (tokenLabel !== null) children.push(h("span", { key: "tokens", className: "dtc-part" }, tokenLabel));
      if (tokenLabel !== null && durationLabel !== null) children.push(h("span", { key: "sep", className: "dtc-sep", "aria-hidden": "true" }, "·"));
      if (durationLabel !== null) children.push(h("span", { key: "duration", className: "dtc-part" }, durationLabel));
      if (sessionLabel !== null) {
        children.push(h("span", { key: "sep-session", className: "dtc-sep", "aria-hidden": "true" }, "·"));
        children.push(h("span", { key: "session", className: "dtc-part dtc-session" }, sessionLabel));
      }

      const ariaParts = [];
      if (tokenLabel !== null) ariaParts.push(t("ariaTokens", { tokens: tokenLabel }));
      if (durationLabel !== null) ariaParts.push(t("ariaDuration", { duration: durationLabel }));
      if (sessionLabel !== null) ariaParts.push(t("ariaSession", { tokens: sessionLabel }));

      return {
        children,
        ariaLabel: ariaParts.join(t("listSeparator")),
        title: buildTooltip(usage, durationLabel, sessionTotal, t),
      };
    }

    /** 悬停提示：标题 + 精确总量与分桶 + 耗时，空行分段。缺项自动省略。 */
    function buildTooltip(usage, durationLabel, sessionTotal, t) {
      const lines = [];
      if (usage !== null) {
        lines.push(t("tooltipTitle"));
        const buckets = [t("tooltipTotal", { total: exactCount(usage.total) })];
        if (usage.input !== undefined) buckets.push(t("tooltipInput", { count: exactCount(usage.input) }));
        if (usage.cacheRead !== undefined) buckets.push(t("tooltipCacheRead", { count: exactCount(usage.cacheRead) }));
        if (usage.cacheWrite !== undefined) buckets.push(t("tooltipCacheWrite", { count: exactCount(usage.cacheWrite) }));
        if (usage.output !== undefined) {
          const reasoning = usage.reasoning === undefined ? "" : t("tooltipReasoning", { count: exactCount(usage.reasoning) });
          buckets.push(`${t("tooltipOutput", { count: exactCount(usage.output) })}${reasoning}`);
        }
        lines.push(buckets.join(" · "));
      }
      if (durationLabel !== null) lines.push(t("tooltipDuration", { duration: durationLabel }));
      return lines.join("\n");
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const STYLE_ID = "dsh-token-usage-badge";
    const STYLE_CSS = `
.dtc-rule {
  width: 100%;
  height: 1px;
  /* 位置由 centerRule() 量出来的 translateY 决定，这里不再预留 margin */
  margin-top: 0;
  border-radius: 1px;
  background: var(--dsw-alias-border-l2);
  opacity: 0.72;
}
.dtc-metrics {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 7px;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) + 1.5px);
  line-height: calc(20px + var(--dsh-content-font-delta, 0px));
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
  cursor: default;
  letter-spacing: 0.01em;
}
.dtc-metrics:hover {
  color: var(--dsw-alias-label-primary);
}
.dtc-part {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}
.dtc-sep {
  opacity: 0.4;
}
.dtc-session {
  opacity: 0.86;
}
/* 运行中的实时用量：紧跟“深度求索中，用时 N秒”，每步刷新一次 */
.dtc-live-chip {
  margin-left: 8px;
  font-size: inherit;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
}
/* 第一步还没结算时显示的是文字量估算（带 ~），比精确值淡一点 */
.dtc-live-chip[data-dtc-estimate="1"] {
  opacity: 0.72;
  font-weight: 500;
}
/* 读数常驻：官方只在“最后一条回答”常显动作行，其余回合需悬停；
   这里仅对含本插件读数的动作行强制显示（不影响其他回合）。 */
[data-turn-tail]:has([data-dsh-token-usage-badge]) [data-clock="end"] {
  opacity: 1 !important;
}
`;

    function ensureStyle(doc) {
      if (doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
      const style = doc.createElement("style");
      style.setAttribute("data-plugin-css", STYLE_ID);
      style.textContent = STYLE_CSS;
      doc.head.appendChild(style);
      return () => {
        style.remove();
      };
    }


    // ── 生成过程中停在回答第一行 ────────────────────────────────────────────
    // 官方在回答生成时一路跟随到底部（读者永远落在最新一行）。这里反过来：本轮回答的
    // 第一行一出现，就把视口钉在这一行上，正文继续往下长、不再带着读者走。
    // 读者自己滚动 / 敲滚动键就立刻交还控制权，本轮内不再抢。
    const PIN_PAD = 16;              // 回答第一行顶端留白
    const PIN_SETTLE_MS = 2000;      // 回合结束后继续钉这么久，等完成时的折叠动画落定
    const SCROLLER_SELECTOR = "[data-conversation-scroll]";
    const RUNNING_SELECTOR = "[data-chat-running]";
    const ANSWER_SELECTOR = '[data-chat-group-part="response"]';
    const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
    let pinning = false;             // 给补底逻辑让路用

    function chatScroller() {
      const flow = document.querySelector("[data-chat-flow]");
      if (flow === null) return null;
      return flow.closest(SCROLLER_SELECTOR) ?? scrollHostAncestor(flow);
    }

    /**
     * 当前这一轮回答正文那一行。
     * 回答块被宿主标成 groupPart="response"；回合号取滚动区里最大的 data-chat-turn，
     * 这样“新回合刚在想、回答还没出现”时不会把上一条回答误认成本轮。
     */
    function latestAnswerRow(scroller) {
      let turn = -1;
      for (const element of scroller.querySelectorAll("[data-chat-turn]")) {
        const value = Number(element.getAttribute("data-chat-turn"));
        if (Number.isFinite(value) && value > turn) turn = value;
      }
      if (turn < 0) return null;
      const rows = scroller.querySelectorAll(`${ANSWER_SELECTOR}[data-chat-turn="${turn}"]`);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.getBoundingClientRect().height > 0.5) return row;
      }
      return null;
    }

    /**
     * 把回答第一行钉在视口顶部。
     * 宿主每收到一点内容就把视图写到最底部（instant），所以这里每帧写回目标位置；
     * 这些写入会被宿主判成“读者移动”，约 500ms 采样后它自己就不再跟随了，
     * 之后只有上方过程行高度变化时才需要再补一次。
     */
    function keepAnswerAtTop() {
      let frame = 0;
      let watching = false;
      let running = document.querySelector(RUNNING_SELECTOR) !== null;
      let endedAt = 0;
      let engaged = false;         // 已成功钉住过（此后读者的滚动才算“交还控制权”）
      let released = false;        // 本轮读者接管了滚动
      let row = null;
      let scannedAt = 0;
      let scroller = null;

      function align() {
        try {
          const host = chatScroller();
          if (host === null) return false;
          if (host !== scroller) {
            if (scroller !== null) scroller.removeEventListener("scroll", onNativeScroll);
            scroller = host;
            scroller.addEventListener("scroll", onNativeScroll, { passive: true });
          }
          if (row === null || !row.isConnected || !scroller.contains(row)) {
            // 回答还没出现时也不必每帧扫整棵 DOM，150ms 一次足够。
            if (Date.now() - scannedAt > 150) {
              scannedAt = Date.now();
              row = latestAnswerRow(scroller);
            }
          }
          if (row === null) return false;
          const limit = scroller.scrollHeight - scroller.clientHeight;
          if (limit <= 1) return false;
          const box = scroller.getBoundingClientRect();
          const offset = row.getBoundingClientRect().top - box.top;
          const want = Math.max(0, Math.min(limit, scroller.scrollTop + offset - PIN_PAD));
          if (Math.abs(scroller.scrollTop - want) > 1) scroller.scrollTop = want;
          engaged = true;
          pinning = true;
          return true;
        } catch {
          return false;   // 布局异常时宁可不动，也不让滚动逻辑牵连对话
        }
      }

      // 宿主的贴底写入会触发 scroll；在它之后、本帧绘制之前再对齐一次，避免闪一下底部。
      function onNativeScroll() {
        if (released || !engaged) return;
        align();
      }

      function tick() {
        frame = 0;
        const live = document.querySelector(RUNNING_SELECTOR) !== null;
        if (live !== running) {
          running = live;
          if (live) {
            endedAt = 0;
            released = false;
            engaged = false;
            // 新回合要从“这一轮的回答”重新找，别钉着上一轮的回答行。
            row = null;
            scannedAt = 0;
          } else {
            endedAt = Date.now();
          }
        }
        const settled = !running && endedAt !== 0 && Date.now() - endedAt > PIN_SETTLE_MS;
        if (settled) {
          watching = false;
          pinning = false;
          engaged = false;
          row = null;
          return;
        }
        if (!released) align();
        frame = requestAnimationFrame(tick);
      }

      function onIntent(event) {
        if (event.type === "keydown") {
          if (!(event instanceof KeyboardEvent) || !SCROLL_KEYS.has(event.key)) return;
          if (event.target instanceof Element && event.target.closest("[data-composer-seat]") !== null) return;
        } else {
          const host = chatScroller();
          if (host === null || !(event.target instanceof Node) || !host.contains(event.target)) return;
        }
        // 还没钉住过（比如回答尚未开始）时，读者的滚动不算放弃本轮。
        if (released || !engaged) return;
        released = true;
        pinning = false;
        row = null;
      }

      function wake() {
        if (!watching) return;
        if (frame === 0) frame = requestAnimationFrame(tick);
      }

      // 会话 running 出现 = 新回合，开始盯；消失后由 tick 里的 settle 收尾。
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (!(record.target instanceof Element) || !record.target.isConnected) continue;
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (node instanceof Element && node.matches(RUNNING_SELECTOR)) {
              watching = true;
              wake();
              return;
            }
          }
        }
      });
      document.addEventListener("wheel", onIntent, { capture: true, passive: true });
      document.addEventListener("touchstart", onIntent, { capture: true, passive: true });
      document.addEventListener("pointerdown", onIntent, { capture: true, passive: true });
      document.addEventListener("keydown", onIntent, true);
      try {
        observer.observe(document.body, { childList: true, subtree: true });
      } catch { /* ignore */ }
      if (running) {
        watching = true;
        wake();
      }
      return () => {
        watching = false;
        pinning = false;
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
        observer.disconnect();
        if (scroller !== null) scroller.removeEventListener("scroll", onNativeScroll);
        document.removeEventListener("wheel", onIntent, true);
        document.removeEventListener("touchstart", onIntent, true);
        document.removeEventListener("pointerdown", onIntent, true);
        document.removeEventListener("keydown", onIntent, true);
      };
    }

    // ── 跟随修复：布局把“贴底”弄丢时补回去 ────────────────────────────────
    /**
     * 跟随被打断有两类，症状都是“界面不在最底下、还在往上跑”：
     *
     *   A) 内容先撑高再塌陷：宿主按撑高后的底部发起平滑滚动，元素塌陷后目标失效，
     *      滚动停在半路（实测停在离底部 200~800px 处）。
     *   B) 视口被挤矮：输入框上方的插件卡片、折叠面板等让滚动区变矮，而滚动位置
     *      没动；floors 变大、dist 跟着变大，看起来就是内容一路往上跑。
     *
     * 判据（A）：最近 1 秒内滚动高度比现在高过 20px（发生过塌陷），且塌陷前贴着底部。
     * 判据（B）：上一拍还贴着底部（dist ≤ 4），这一拍 floor 变大 > 16px、滚动位置
     *           完全没动（不是读者滚的，也不是宿主追加内容时的写入）。
     * 两者都要求 300ms 内没有读者滚动意图，才补一次贴底。
     */
    function healCollapsedFollow() {
      let scroller = null;
      let samples = [];            // { floor, dist, top }
      const SAMPLE_WINDOW = 10;
      let healing = false;
      let intentAt = 0;            // 最近一次“读者意图”时间（wheel / 方向键）

      const measure = () => {
        if (scroller === null) return null;
        const floor = scroller.scrollHeight - scroller.clientHeight;
        return { floor, dist: floor - scroller.scrollTop, top: scroller.scrollTop };
      };
      const push = (now) => {
        const m = measure();
        if (m === null) return;
        samples.push(m);
        if (samples.length > SAMPLE_WINDOW) samples.shift();
        if (now === undefined) return;
      };

      const snap = () => {
        if (scroller === null) return;
        healing = true;
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        requestAnimationFrame(() => {
          if (scroller !== null) scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
          setTimeout(() => { healing = false; }, 120);
        });
        samples = [];
      };

      const evaluate = () => {
        // 视图正被“钉在回答第一行”时，补底逻辑必须让路；
        // 会话不在 running（没有 [data-chat-running]）时也没有跟随可修。
        if (pinning) return;
        if (document.querySelector(RUNNING_SELECTOR) === null) return;
        const m = measure();
        if (m === null) return;
        const last = samples.length > 0 ? samples[samples.length - 1] : null;
        const peak = samples.reduce((max, s) => Math.max(max, s.floor), m.floor);
        const wasFollowing = samples.some((s) => s.dist <= 4);
        const collapsed = peak - m.floor > 20;
        // 只由布局引起的“掉出底部”：滚动位置一动没动，floor 却变大了。
        const viewportShrank = last !== null
          && m.floor - last.floor > 16
          && Math.abs(m.top - last.top) < 1
          && last.dist <= 4
          && m.dist > 4;
        samples.push(m);
        if (samples.length > SAMPLE_WINDOW) samples.shift();
        if (healing) return;
        if (!collapsed && !viewportShrank) return;
        if (!wasFollowing) return;
        if (Date.now() - intentAt < 300) return;
        snap();
      };

      const onScroll = () => {
        if (healing) return;
        if (Date.now() - intentAt < 300) { push(); return; }  // 读者自己滚的，只记录
        evaluate();                                            // 程序/布局引起的滚动：检查是否掉队
      };
      const onIntent = () => { intentAt = Date.now(); };

      const attach = () => {
        const flowNode = document.querySelector("[data-chat-flow-kind]");
        const next = flowNode === null ? null : scrollHostAncestor(flowNode);
        if (next === scroller) return;
        if (scroller !== null) {
          scroller.removeEventListener("scroll", onScroll);
          scroller.removeEventListener("wheel", onIntent);
        }
        scroller = next;
        samples = [];
        if (scroller !== null) {
          scroller.addEventListener("scroll", onScroll, { passive: true });
          scroller.addEventListener("wheel", onIntent, { passive: true });
          push();                       // 立即播种：此刻若贴底，就是塌陷前的“在底部”证据
        }
      };
      document.addEventListener("keydown", onIntent, true);

      attach();                          // 不要等第一个 tick，否则塌陷会发生在播种之前
      const timer = setInterval(() => { attach(); evaluate(); }, 200);
      return () => {
        clearInterval(timer);
        document.removeEventListener("keydown", onIntent, true);
        if (scroller !== null) {
          scroller.removeEventListener("scroll", onScroll);
          scroller.removeEventListener("wheel", onIntent);
        }
      };
    }


    // ── 运行中的实时用量 ────────────────────────────────────────────────────
    // 数据来源：会话 tokenUsage 投影，与回答下方读数是同一口径。宿主在每个步骤
    // 落盘后才更新它，所以状态行右边这个数字是「每步刷新一次的真实值」，
    // 不按字符做估算。
    // 展示位置：官方状态行「深度求索中，用时 …」的右端——该行本来就被我们改成了
    // flex 布局（文字在左、细线占满、读数贴右），不需要额外插入新的一行。
    const LIVE_ATTR = "data-dtc-live-chip";
    // 输入框下方槽位：只挂一个渲染 null 的探针，用来全天候读会话投影。
    const PROBE_SLOT = "conversation.composer.dock";
    const PROBE_ID = "dsh-token-usage-badge-probe";

    // 会话总量（tokenUsage 投影）、本轮起点快照、本轮增量。
    // 现场按「进行中的回合」各存一份：切走再切回同一个还在生成的回合时，读数立刻恢复，
    // 不必等宿主再落盘一次；真的换了一轮才重设起点。
    const liveStore = { total: undefined, baseline: undefined, used: undefined, turnKey: undefined };
    const liveCache = new Map();

    function saveLive() {
      if (liveStore.turnKey === undefined) return;
      if (typeof liveStore.baseline !== "number") {
        liveCache.delete(liveStore.turnKey);
        return;
      }
      liveCache.set(liveStore.turnKey, { baseline: liveStore.baseline, used: liveStore.used });
    }

    /** 换到一个进行中的回合：有存档就沿用该回合的起点，没有就以此刻的会话总量为起点。 */
    function adoptTurn(turnKey) {
      const saved = liveCache.get(turnKey);
      liveStore.turnKey = turnKey;
      if (saved !== undefined) {
        liveStore.baseline = saved.baseline;
        liveStore.used = saved.used;
        reconcileLive();
      } else {
        liveStore.baseline = typeof liveStore.total === "number" ? liveStore.total : undefined;
        liveStore.used = liveStore.baseline === undefined ? undefined : 0;
      }
      saveLive();
    }

    /** 由每个 TurnMetrics / 探针把最新的会话总量推给状态行读数。 */
    function pushSessionTotal(total) {
      // 会话累计只会涨；变小说明换到了另一个会话（或会话被重置），旧起点到此作废，
      // 否则会拿上一个会话的总量当起点，把本轮读数压成 0 并一直不显示。
      if (typeof total === "number" && typeof liveStore.total === "number" && total < liveStore.total) {
        liveStore.baseline = undefined;
        liveStore.used = undefined;
      }
      if (typeof total === "number" && total >= 0) {
        liveStore.total = total;
        reconcileLive();
      }
      saveLive();
    }

    /**
     * 本轮增量 = 当前会话总量 − 本轮开始那一刻的会话总量。
     * 起点未知时宁可不显示：绝不能拿会话累计当成本轮用量（那正是之前的错误）。
     */
    function reconcileLive() {
      if (typeof liveStore.total !== "number") {
        liveStore.used = undefined;
        return;
      }
      if (typeof liveStore.baseline !== "number") {
        // 会话里还没有任何已完成的回合时，会话累计就是本轮累计，起点按 0 算；
        // 否则起点取「此刻的会话累计」，第一轮之后才出现的读数才不会把历史算进来。
        const noCompletedTurn = document.querySelector("[data-turn-tail]") === null;
        liveStore.baseline = noCompletedTurn ? 0 : liveStore.total;
        liveStore.used = Math.max(0, liveStore.total - liveStore.baseline);
        return;
      }
      liveStore.used = Math.max(0, liveStore.total - liveStore.baseline);
    }

    /** 当前进行中的回合标识：用来在换轮时重设起点，避免把上一轮的用量算进来。 */
    function currentTurnKey() {
      const turns = document.querySelectorAll("[data-chat-turn]");
      if (turns.length > 0) {
        const last = turns[turns.length - 1];
        const id = last.getAttribute("data-chat-turn");
        if (id !== null && id !== "") return "turn:" + id;
        return "turn#" + turns.length;
      }
      return "flow#" + document.querySelectorAll('[data-chat-flow-kind="user"]').length;
    }

    /**
     * 隐形探针：常驻在输入框下方槽位，只读会话 tokenUsage 投影并推给状态行读数，
     * 自身渲染 null。这样即使当前会话还没有任何 turn-tail（第一条提问进行中），
     * 状态行右侧也能取到会话总量。
     */
    function LiveUsageProbe(props) {
      const useProjection = typeof props?.useProjection === "function" ? props.useProjection : null;
      const sessionUsage = useProjection === null ? undefined : useProjection("tokenUsage");
      const total = sessionTotalOf(sessionUsage);
      React.useEffect(() => {
        pushSessionTotal(total);
      }, [total]);
      return null;
    }

    // ── 去重：同一条回答只留一份读数 ─────────────────────────────────────────
    // 热更新 / 改名 / 多窗口并存时，页面里可能同时驻留旧版插件模块和当前版本，
    // 它们都会往同一个动作行里插读数与分隔线。这里把“不是本实例”的节点隐藏掉，
    // 只做 display 切换、不删 DOM —— 删除别人的 React 节点会让对方的重渲染报错。
    const OWNER_ATTR = 'data-dtc-owner'
    const METRIC_SELECTOR = '[data-dsh-turn-metrics], [data-dsh-token-clock], [data-dsh-token-usage-badge]'

    function enforceSingleRenderer() {
      let frame = 0

      const hide = (node) => {
        if (node !== null && node.style.display !== 'none') node.style.display = 'none'
      }

      const run = () => {
        for (const tail of document.querySelectorAll('[data-turn-tail]')) {
          // 分隔线：只保留带 owner 标记的那一条
          const rules = tail.querySelectorAll('.dtc-rule, .dtm-rule')
          let mineRule = null
          for (const rule of rules) {
            if (rule.hasAttribute(OWNER_ATTR)) {
              mineRule = rule
              break
            }
          }
          for (const rule of rules) if (rule !== mineRule) hide(rule)

          // 读数：每个动作行只保留带 owner 标记的那一颗
          for (const row of tail.querySelectorAll('[data-clock="end"]')) {
            const metrics = row.querySelectorAll(METRIC_SELECTOR)
            let mine = null
            for (const node of metrics) {
              if (node.hasAttribute(OWNER_ATTR)) {
                mine = node
                break
              }
            }
            for (const node of metrics) if (node !== mine) hide(node)
          }
        }
      }

      const schedule = () => {
        if (frame !== 0) return
        frame = requestAnimationFrame(() => {
          frame = 0
          run()
        })
      }

      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      const timer = setInterval(run, 1000)
      run()
      return () => {
        clearInterval(timer)
        observer.disconnect()
        if (frame !== 0) cancelAnimationFrame(frame)
      }
    }


    // ── 运行状态行：清理旧版残留 + 左对齐 ────────────────────────────────────
    // 1.1.2~1.1.3 曾在状态行里插入 “X tok” chip 并改过行内联样式；升级后旧节点
    // 可能还留在 DOM 里（组件已卸载、清理没跑），表现为文字与 chip 叠字。
    // 这里统一清掉残留，并把状态行固定成左对齐：文字在前、细线在后。
    // 首步结算之前宿主还没上报任何用量：用已流出的文字量估个量级，带 ~ 标记，结算后立刻换成精确值。
    const ESTIMATE_PER_HAN = 0.7
    const ESTIMATE_PER_OTHER = 0.25
    const ESTIMATE_TEXT_CAP = 40000
    const HAN_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g

    /**
     * 只统计「当前回合、用户指令之后」的正文文字，换成 token 量级的估计值。
     * 第一步结算前不可能有工具结果，所以这段文字基本就是本步的输出与思考。
     */
    function streamedOutputEstimate() {
      const users = document.querySelectorAll('[data-chat-flow-kind="user"]')
      const lastUser = users.length > 0 ? users[users.length - 1] : null
      let han = 0
      let other = 0
      for (const part of document.querySelectorAll('[data-chat-group-part="response"]')) {
        if (lastUser !== null) {
          const position = lastUser.compareDocumentPosition(part)
          if ((position & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
        }
        const text = part.textContent || ''
        if (text === '') continue
        const slice = text.length > ESTIMATE_TEXT_CAP ? text.slice(0, ESTIMATE_TEXT_CAP) : text
        const hanCount = (slice.match(HAN_PATTERN) || []).length
        han += hanCount
        other += slice.length - hanCount
      }
      return han * ESTIMATE_PER_HAN + other * ESTIMATE_PER_OTHER
    }

    function tidyRunningStatus() {
      let frame = 0

      const run = () => {
        for (const leftover of document.querySelectorAll('.dtc-live, [data-dtc-live]')) {
          leftover.remove()
        }
        const host = document.querySelector('[data-chat-running]')
        if (host === null) {
          // 没有进行中的回合：不驱动读数，也别清空存档，切回还在生成的回合时还要用它。
          return
        }

        // 恢复被旧版改写的行内样式（只清我们写过的那几个值）
        if (host.style.justifyContent !== 'flex-start') host.style.justifyContent = 'flex-start'
        if (host.style.display !== 'flex') host.style.display = 'flex'
        if (host.style.flexDirection !== 'row') host.style.flexDirection = 'row'
        if (host.style.alignItems !== 'center') host.style.alignItems = 'center'
        if (host.style.flexWrap !== 'nowrap') host.style.flexWrap = 'nowrap'

        let content = null
        let divider = null
        for (const child of host.children) {
          if (child.tagName !== 'SPAN') continue
          const text = child.textContent || ''
          const box = child.getBoundingClientRect()
          if (text.indexOf('深度求索') !== -1 || text.indexOf('Deep diving') !== -1) {
            if (box.width > 1) content = child
            continue
          }
          if (box.height <= 2 && box.width > 2) divider = child
        }

        if (content !== null) {
          if (content.style.order !== '-1') content.style.order = '-1'
          if (content.style.whiteSpace !== 'nowrap') content.style.whiteSpace = 'nowrap'
          if (content.style.flex !== '0 0 auto') content.style.flex = '0 0 auto'
        }
        if (divider !== null) {
          if (divider.style.order !== '1') divider.style.order = '1'
          if (divider.style.flex !== '1 1 auto') divider.style.flex = '1 1 auto'
          if (divider.style.marginLeft !== '10px') divider.style.marginLeft = '10px'
        }

        // 本次回答的实时读数：换轮时重设起点，只用「本轮增量」，绝不显示会话累计。
        // 切回一个还在生成的回合时 turnKey 没变，存档原样保留，读数当帧就有。
        const turnKey = currentTurnKey()
        if (liveStore.turnKey !== turnKey) adoptTurn(turnKey)
        let chip = null
        for (const child of host.children) {
          if (child.hasAttribute && child.hasAttribute(LIVE_ATTR)) {
            chip = child
            break
          }
        }
        const exact = typeof liveStore.used === 'number' && liveStore.used >= 1 ? liveStore.used : null
        const shown = exact !== null ? exact : streamedOutputEstimate()
        if (shown >= 1) {
          if (chip === null) {
            chip = document.createElement('span')
            chip.className = 'dtc-live-chip'
            chip.setAttribute(LIVE_ATTR, '')
            host.appendChild(chip)
          }
          if (chip.style.order !== '0') chip.style.order = '0'
          if (chip.style.flex !== '0 0 auto') chip.style.flex = '0 0 auto'
          // 紧跟在“深度求索中，用时 N秒”后面，而不是被细线推到右端
          if (content !== null && chip.previousElementSibling !== content) {
            content.insertAdjacentElement('afterend', chip)
          }
          const text = exact !== null ? `+${compactCount(exact)} tok` : `~${compactCount(shown)} tok`
          if (chip.textContent !== text) chip.textContent = text
          const estimateMark = exact === null ? '1' : '0'
          if (chip.getAttribute('data-dtc-estimate') !== estimateMark) chip.setAttribute('data-dtc-estimate', estimateMark)
          if (chip.style.display !== 'inline-block') chip.style.display = 'inline-block'
        } else if (chip !== null) {
          chip.remove()
          chip = null
        }
      }

      const schedule = () => {
        if (frame !== 0) return
        frame = requestAnimationFrame(() => {
          frame = 0
          run()
        })
      }

      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      const timer = setInterval(run, 1000)
      run()
      return () => {
        clearInterval(timer)
        observer.disconnect()
        if (frame !== 0) cancelAnimationFrame(frame)
      }
    }


    // ── 插件体 ──────────────────────────────────────────────────────────────

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => ensureStyle(document), "dsh-token-usage-badge: styles");
        ctx.effect(
          () => ctx.locale.register(NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }),
          "dsh-token-usage-badge: dictionaries",
        );
        ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS },
          TurnMetrics,
        ));
        // 探针只是锦上添花：槽位不存在或注册被拒都不该影响下面的读数与分隔线
        try {
          ctx.slots.inject(PROBE_SLOT, () => ctx.slots.register(
            { name: PROBE_SLOT, id: PROBE_ID, order: 0, locale: NS },
            LiveUsageProbe,
          ));
        } catch { /* ignore probe failure */ }
        ctx.effect(enforceSingleRenderer, 'token-usage-badge: single renderer');
        ctx.effect(tidyRunningStatus, 'token-usage-badge: tidy running status');
      },
    };
  },
});
