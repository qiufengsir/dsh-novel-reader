window.__ModuleLoader__.load({id:"dsh-zhijian-reader",factory:(require)=>{const React=require('react');
(function (root) {
  "use strict";
  function decode(buffer, encoding = "auto") {
    const bytes = new Uint8Array(buffer);
    let label = encoding;
    if (label === "auto") {
      if (bytes[0] === 255 && bytes[1] === 254) label = "utf-16le";
      else if (bytes[0] === 254 && bytes[1] === 255) label = "utf-16be";
      else {
        try {
          const text = clean(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          if (text.includes("\u0000")) throw Error("binary");
          return { text, encoding: "utf-8" };
        } catch {
          label = "gb18030";
        }
      }
    }
    const text = clean(new TextDecoder(label, { fatal: true }).decode(bytes));
    if (text.includes("\u0000"))
      throw Error("文件包含二进制数据，或编码选择不正确。");
    return { text, encoding: label };
  }
  function clean(text) {
    return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }
  // Recognize standalone headings; ordinary prose beginning with 后记/番外 etc.
  // must stay in its chapter. Source line indexes always refer to the original text.
  function chapterHeading(source) {
    let title = source.trim().normalize("NFKC");
    if (!title || title.length > 90) return false;
    title = title.replace(/^正文[\s:：]+/u, "");
    const bracketed = title.match(/^[【\[]([^】\]]+)[】\]]\s*(.*)$/u);
    if (bracketed) title = bracketed[1] + (bracketed[2] ? " " + bracketed[2] : "");
    const numbered = title.match(/^(第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟\d]+[章回节卷部篇集])(.*)$/u);
    if (numbered) {
      const tail = numbered[2];
      if (!tail) return true;
      // Explicitly separated chapter names may contain expressive punctuation.
      if (/^[\s:：、.．·]/u.test(tail)) return tail.trim().length <= 64;
      return tail.length <= 45 && !/^(?:的|里|是|最后|已经|之后|之前|卷末|开卷后|流下|中[，,。])/u.test(tail);
    }
    if (/^(?:chapter|book|part)\s+(?:\d+|[ivxlcdm]+)(?:\s|[.:：—-]|$)/i.test(title))
      return !/[。；;]/u.test(title);
    return /^(?:序章|序言|楔子|引子|前言|后记|尾声|终章|番外)(?:$|[\s:：、—·-]+[^。；;]{1,60}$|[（(][^）)]{1,60}[）)]$)/u.test(title) || /^番外(?:预告|[零〇一二三四五六七八九十\d]+(?:[\s:：、·-].{1,50})?)$/u.test(title);
  }
  function chapters(text) {
    const lines = text.split("\n"), out = [];
    lines.forEach((line, i) => {
      if (chapterHeading(line)) out.push({ title: line.trim(), start: i, heading: true });
    });
    if (!out.length) {
      for (let i = 0; i < lines.length; i += 180)
        out.push({ title: i === 0 ? "正文" : `正文 · ${out.length + 1}`, start: i, heading: false });
    } else if (out[0].start > 0) out.unshift({ title: "卷首", start: 0, heading: false });
    return out.map((c, i) => ({ ...c, end: out[i + 1]?.start ?? lines.length }));
  }
  function search(lines, query, limit = 200) {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [];
    const out = [];
    for (let i = 0; i < lines.length && out.length < limit; i++)
      if (lines[i].toLocaleLowerCase().includes(q))
        out.push({ line: i, text: lines[i] });
    return out;
  }
  const api = { decode, chapters, search };
  if (typeof module !== "undefined") module.exports = api;
  else root.ZhijianReaderCore = api;
})(globalThis);

(function (root) {
  "use strict";

  // Read the Controller's retained Session sources. This adapter never opens a
  // Session, submits a prompt, inspects prompt content, or polls the document.
  function createSource(ctx, fixedSessionId) {
    const sessions = ctx?.sessions;
    const uiSession = ctx?.uiSession;
    const current = uiSession?.adapter?.current;
    const statusSource = uiSession?.sessionStatus;
    const listeners = new Set();
    const disposers = [];
    const sessionGates = new Map();
    let requestedId = fixedSessionId;
    let bindingDisposers = [];
    let binding;
    let selectedId;
    let disposed = false;
    let refreshing = false;
    let refreshAgain = false;
    let revision;
    let lastSeq = -1;
    let noticeId = 0;
    let gate;
    let runtimeErrorActive = false;
    let runtimeErrorSeen = false;
    let previousAgentError;
    let facts = initialFacts();
    let snapshot = Object.freeze({
      sessionId: undefined, title: "", phase: "unlinked",
      noticeId: 0, submitted: false, canRead: true,
    });

    function initialFacts() {
      return { submitted: false, phase: "idle", terminal: false, openTurn: false, latestTaskSeq: -1 };
    }
    function read(source, fallback) {
      try { return source?.getSnapshot?.() ?? fallback; }
      catch { return fallback; }
    }
    function watch(source, callback, group) {
      if (typeof source?.subscribe !== "function") return;
      const unsubscribe = source.subscribe(callback);
      if (typeof unsubscribe === "function") group.push(unsubscribe);
    }
    function publish(next) {
      if (Object.keys(next).every((key) => Object.is(next[key], snapshot[key]))) return;
      snapshot = Object.freeze(next);
      for (const listener of [...listeners]) listener();
    }
    function fold(entry, live) {
      if (entry?.type !== "event" || !entry.event) return;
      const event = entry.event;
      const seq = Number(event.seq);
      if (live && Number.isFinite(seq) && seq <= lastSeq) return;
      if (Number.isFinite(seq)) {
        lastSeq = Math.max(lastSeq, seq);
        gate.seenSeq = Math.max(gate.seenSeq, seq);
      }
      const data = event.data || {};
      const userMessage = event.type === "user/message" &&
        event.surfaceOp === "append" && data.source?.kind === "user";
      const acceptedInput = event.type === "agent/inbox/spliced" &&
        (data.target === "next-turn" || data.target === "next-step") &&
        Array.isArray(data.inserted) && data.inserted.some((message) => message?.source?.kind === "user");
      if (userMessage || acceptedInput) {
        facts.latestTaskSeq = seq;
        if (Number.isFinite(seq)) gate.userSeq = Math.max(gate.userSeq, seq);
        facts.submitted = gate.userSeq > gate.completedSeq;
        runtimeErrorActive = false;
        // A queued accepted requirement is pending work even before turn/start.
        facts.phase = "running";
        facts.terminal = false;
      } else if (event.type === "turn/start") {
        facts.latestTaskSeq = seq;
        runtimeErrorActive = false;
        facts.openTurn = true;
        facts.terminal = false;
        facts.phase = "running";
        // A goal, timer, subagent, or automatic continuation does not establish
        // human submission and cannot unlock reading after a completed turn.
      } else if (event.type === "turn/end") {
        facts.latestTaskSeq = seq;
        runtimeErrorActive = false;
        facts.openTurn = false;
        facts.terminal = true;
        const kind = data.reason?.kind;
        if (kind === "completed") {
          facts.phase = "completed";
          if (Number.isFinite(seq)) gate.completedSeq = Math.max(gate.completedSeq, seq);
          gate.initialRunAllowed = false;
          facts.submitted = gate.userSeq > gate.completedSeq;
        } else if (kind === "error") facts.phase = "error";
        else facts.phase = "stopped";
        if (live) noticeId += 1;
      }
    }
    function baseline(window) {
      facts = initialFacts();
      lastSeq = gate.seenSeq;
      for (const entry of window?.entries || []) fold(entry, false);
      // Window replacement and backwards paging can omit a newer user prompt.
      // Keep sequence-only evidence already observed by this source; never
      // retain the prompt text or treat old prepended input as a new demand.
      facts.submitted = gate.userSeq > gate.completedSeq;
      if (facts.submitted && gate.userSeq > facts.latestTaskSeq) {
        facts.terminal = false;
        facts.phase = "running";
      } else if (!facts.submitted && gate.completedSeq >= 0 && gate.completedSeq >= facts.latestTaskSeq) {
        facts.terminal = true;
        facts.openTurn = false;
        facts.phase = "completed";
      }
      revision = window?.revision;
    }
    function acceptFeed() {
      if (disposed || !binding) return;
      const window = read(binding.eventSource, undefined);
      if (!window) return;
      if (window.revision !== undefined && window.revision === revision) return;
      if (window.change?.kind === "append") {
        for (const entry of window.change.entries || []) fold(entry, true);
        revision = window.revision;
      } else if (window.change?.kind === "settle-assistant") {
        // Assistant settlement has no task lifecycle facts. Its committed seq
        // still advances the duplicate guard without retaining message data.
        const seq = Number(window.change.entry?.event?.seq);
        if (Number.isFinite(seq)) {
          lastSeq = Math.max(lastSeq, seq);
          gate.seenSeq = Math.max(gate.seenSeq, seq);
        }
        revision = window.revision;
      } else {
        // Reconnect, history replacement, and pagination rebuild state without
        // replaying historical completion reminders.
        baseline(window);
      }
      refresh();
    }
    function detachBinding() {
      for (const dispose of bindingDisposers.splice(0)) dispose();
      binding = undefined;
    }
    function refresh() {
      if (disposed) return;
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          const list = read(sessions?.list, { byId: {}, phase: "pending" });
          const id = typeof requestedId === "string" && requestedId
            ? requestedId : read(current, {})?.key;
          let nextBinding;
          try { nextBinding = id ? sessions?.binding?.(id) : undefined; }
          catch { nextBinding = undefined; }
          if (selectedId !== id || binding !== nextBinding) {
            detachBinding();
            selectedId = id;
            binding = nextBinding;
            gate = sessionGates.get(id);
            if (!gate) {
              gate = { userSeq: -1, completedSeq: -1, seenSeq: -1, initialEvaluated: false, initialRunAllowed: false };
              if (id) sessionGates.set(id, gate);
            }
            facts = initialFacts();
            runtimeErrorActive = false;
            runtimeErrorSeen = false;
            previousAgentError = undefined;
            revision = undefined;
            lastSeq = -1;
            if (binding) {
              baseline(read(binding.eventSource, undefined));
              watch(binding.eventSource, acceptFeed, bindingDisposers);
              watch(binding.session, refresh, bindingDisposers);
            }
          }
          const row = list.byId?.[id];
          const title = typeof row?.displayTitle === "string" ? row.displayTitle
            : typeof row?.title === "string" ? row.title : "";
          let phase = "unlinked";
          let canRead = true;
          if (sessions && uiSession && id) {
            const session = read(binding?.session, {});
            const status = read(statusSource, new Map())?.get?.(id);
            const running = status?.running ?? session.running ?? row?.running;
            const waiting = status?.pendingInteraction != null;
            const loading = ["cold", "loading", "opening", "closed"].includes(session.openState);
            if (binding && !loading && !gate.initialEvaluated) {
              gate.initialEvaluated = true;
              // The first tail window of a very long active turn can start
              // after its original user input. Permit that already-running
              // round once; any observed normal completion revokes this grant.
              gate.initialRunAllowed = gate.completedSeq < 0 && (running === true || facts.openTurn);
            }
            const agentError = session.lastAgentError ?? null;
            if (!runtimeErrorSeen) {
              runtimeErrorSeen = true;
              previousAgentError = agentError;
              runtimeErrorActive = agentError != null;
            } else if (!Object.is(agentError, previousAgentError)) {
              previousAgentError = agentError;
              runtimeErrorActive = agentError != null;
              // This Host channel reports live failures with no turn position.
              // It is not a successful turn and must not strand the UI running.
              if (runtimeErrorActive && !(facts.terminal && facts.phase === "error")) noticeId += 1;
            }
            if (runtimeErrorActive) {
              facts.phase = "error";
              facts.terminal = true;
              facts.openTurn = false;
            }
            // Failure must not undo an earlier completed-turn lock. Keep the
            // conservative readable failure policy only for the first task or
            // a genuine new user requirement accepted after that completion.
            const failureCanRead = gate.completedSeq < 0 || facts.submitted;
            if (!binding || loading) {
              phase = "connecting";
              canRead = false;
            } else if (session.openState === "error" || session.openError || session.removed || runtimeErrorActive) {
              phase = "error";
              canRead = failureCanRead;
            } else if (facts.terminal) {
              // turn/end precedes Host running=false; keep its durable result
              // instead of letting that briefly stale flag reopen the reader.
              phase = facts.phase;
              canRead = phase !== "completed" && failureCanRead;
            } else if (waiting) {
              phase = "waiting";
              canRead = facts.submitted || gate.initialRunAllowed;
            } else if (facts.openTurn || running === true || facts.submitted) {
              phase = "running";
              canRead = facts.submitted || gate.initialRunAllowed;
            } else {
              phase = "idle";
              canRead = false;
            }
          }
          publish({ sessionId: id, title, phase, noticeId, submitted: facts.submitted, canRead });
        } while (refreshAgain && !disposed);
      } finally { refreshing = false; }
    }

    watch(sessions?.list, refresh, disposers);
    watch(current, refresh, disposers);
    watch(statusSource, refresh, disposers);
    refresh();
    return {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        if (disposed) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setSession(sessionId) {
        if (disposed || requestedId === sessionId) return;
        requestedId = sessionId;
        refresh();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        detachBinding();
        for (const dispose of disposers.splice(0)) dispose();
        listeners.clear();
      },
    };
  }

  const api = { createSource };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ZhijianReaderTaskLink = api;
})(globalThis);

function mountReader(root, { taskSource } = {}) {
  const C = globalThis.ZhijianReaderCore;
  let db,
    books = [],
    book,
    lines = [],
    toc = [],
    view = "shelf",
    query = "",
    disposed = false,
    write = Promise.resolve(),
    saveTimer,
    searchTimer,
    restoreFrame,
    restoring = false,
    renderRevision = 0,
    readingChapter = 0,
    scrubOrigin,
    chapterSlider,
    chapterLabel,
    bookLabel,
    returnButton,
    readingLocked = false;
  let task = taskSource?.getSnapshot() || { phase: "unlinked", canRead: true, noticeId: 0 };
  let lastTaskNotice = task.noticeId || 0;
  let lastTaskSession = task.sessionId;
  const jumpHistory = [];
  let settings = {
    theme: "paper",
    font: "serif",
    size: 18,
    leading: 1.9,
    encoding: "auto",
    background: "",
    taskFocus: false,
  };
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const child of children.flat())
      if (child != null)
        n.append(
          child instanceof Node
            ? child
            : document.createTextNode(String(child)),
        );
    return n;
  };
  const button = (text, fn, attrs = {}) =>
    el("button", { type: "button", onClick: fn, ...attrs }, text);
  root.className = "nr";
  root.setAttribute("aria-label", "纸间 · 小说阅读器");
  const header = el(
    "header",
    {},
    el(
      "div",
      {},
      el("div", { class: "brand" }, "纸间 ", el("small", {}, "READER")),
      el("small", {}, "让故事，慢慢发生。"),
    ),
  );
  const input = el("input", {
    type: "file",
    accept: ".txt,.text,.md",
    multiple: "",
    hidden: "",
    onChange: (e) => {
      importFiles(e.target.files);
      e.target.value = "";
    },
  });
  header.append(
    button("＋ 导入", () => input.click(), { class: "primary" }),
    input,
  );
  const nav = el("nav", { "aria-label": "阅读器功能" }),
    notice = el("div", { class: "notice", role: "status", hidden: "" }),
    main = el("main", { tabindex: "0" }),
    footer = el("footer"),
    taskBar = el("section", { class: "task-bar", "aria-label": "dsh 任务联动" }),
    taskStatus = el("span", { class: "task-status", role: "status", "aria-live": "polite" }),
    taskTitle = el("small", { class: "task-title" }),
    focusButton = button("联动专注", toggleTaskFocus, { class: "task-focus", "aria-pressed": "false" }),
    taskNotice = el("section", { class: "task-notice", role: "status", "aria-live": "polite", hidden: "" }),
    lockTitle = el("h2", { id: "nr-lock-title", tabindex: "-1" }),
    lockDescription = el("p", {}),
    lock = el("section", { class: "focus-lock", hidden: "", "aria-labelledby": "nr-lock-title" },
      el("div", { class: "lock-card" },
        el("span", { class: "lock-mark", "aria-hidden": "true" }, "Ⅱ"),
        el("div", { class: "eyebrow" }, "TIME TO BUILD"),
        lockTitle, lockDescription,
        el("small", {}, "阅读位置已保留 · 新需求被 dsh 接受后自动解锁"))),
    stage = el("div", { class: "reader-stage" }, main, lock);
  taskBar.append(el("div", { class: "task-context" }, taskStatus, taskTitle), focusButton);
  root.append(header, nav, taskBar, taskNotice, notice, stage, footer);
  function toggleTaskFocus() {
    settings.taskFocus = !settings.taskFocus;
    if (db) persistSettings();
    updateTaskUI();
  }
  function updateTaskUI() {
    const labels = {
      unlinked: "独立阅读 · 未连接 dsh", connecting: "正在连接当前会话…",
      idle: "等待新的开发需求", running: "dsh 正在执行 · 可以阅读",
      waiting: "dsh 正在等待你的确认", completed: "本轮任务已完成",
      stopped: "本轮执行已停止", error: "本轮执行遇到问题",
    };
    const linked = !["unlinked", "connecting"].includes(task.phase);
    if (task.phase === "running" && !task.canRead) labels.running = "dsh 正在执行 · 专注仍待解锁";
    taskBar.dataset.phase = task.phase;
    taskStatus.textContent = labels[task.phase] || labels.unlinked;
    taskTitle.textContent = task.title || (taskSource?.preview ? "预览模拟 · 不会执行真实任务" : "仅跟随当前会话");
    taskTitle.title = taskTitle.textContent;
    focusButton.setAttribute("aria-pressed", String(settings.taskFocus === true));
    focusButton.title = "开启后，只在当前开发任务执行期间阅读；本轮完成后等待新的需求";
    // Keep connecting conservative when the host source is present; standalone reading remains usable.
    const shouldLock = settings.taskFocus === true && !!taskSource && task.phase !== "unlinked" &&
      task.canRead !== true && view !== "settings";
    const wasLocked = readingLocked;
    const hadReaderFocus = main.contains(document.activeElement) || footer.contains(document.activeElement);
    if (shouldLock && !readingLocked) {
      checkpoint();
      persistPosition();
      const selection = window.getSelection();
      if (selection?.anchorNode && main.contains(selection.anchorNode)) selection.removeAllRanges();
    }
    readingLocked = shouldLock;
    stage.classList.toggle("task-locked", shouldLock);
    main.inert = shouldLock;
    if (shouldLock) main.setAttribute("aria-hidden", "true");
    else main.removeAttribute("aria-hidden");
    footer.style.visibility = shouldLock ? "hidden" : "";
    footer.inert = shouldLock;
    lock.hidden = !shouldLock;
    lockTitle.textContent = task.phase === "completed" ? "任务已完成，回到项目吧" :
      task.phase === "connecting" ? "正在确认任务状态" : "先提出一个新的开发需求";
    lockDescription.textContent = task.phase === "completed"
      ? "这一轮的开发已经结束。去看看结果，提交下一条需求后，再回来继续故事。"
      : task.phase === "connecting" ? "连接当前 dsh 会话后，会自动恢复可用的阅读状态。"
      : "联动专注已开启。在当前会话提交新的需求，dsh 接受后即可继续阅读。";
    if (shouldLock && hadReaderFocus) lockTitle.focus({ preventScroll: true });
    if (wasLocked && !shouldLock && view === "read" && book && !restoring) {
      // Layout may have changed while locked (for example dismissing a notice).
      // Restore the saved paragraph rather than checkpointing a hidden viewport.
      restoring = true;
      const revision = renderRevision;
      restoreFrame = requestAnimationFrame(() => {
        if (disposed || revision !== renderRevision) return;
        const target = main.querySelector(`[data-line="${book.line || 0}"]`);
        if (book.atTop) main.scrollTop = 0;
        else if (target) {
          const rect = target.getBoundingClientRect();
          main.scrollTop += rect.top - main.getBoundingClientRect().top + rect.height * (book.offset || 0);
        }
        restoreFrame = requestAnimationFrame(() => {
          if (disposed || revision !== renderRevision) return;
          restoring = false;
          updateFooterValues();
        });
      });
    }
    root.dataset.taskLinked = String(linked);
  }
  const stopTask = taskSource?.subscribe(() => {
    task = taskSource.getSnapshot();
    if (task.sessionId !== lastTaskSession) {
      lastTaskSession = task.sessionId;
      lastTaskNotice = task.noticeId || 0;
      taskNotice.hidden = true;
    } else if ((task.noticeId || 0) > lastTaskNotice) {
      lastTaskNotice = task.noticeId;
      const text = task.phase === "completed" ? "任务已经完成，回到项目查看结果吧。" :
        task.phase === "error" ? "本轮执行遇到问题，请回到项目查看。" : "本轮执行已停止，请回到项目查看。";
      taskNotice.replaceChildren(el("div", {}, el("strong", {}, task.phase === "completed" ? "✓ 本轮任务已完成" : "请留意开发任务"), el("p", {}, text)),
        button("知道了", () => { taskNotice.hidden = true; }));
      taskNotice.hidden = false;
    }
    if (task.phase === "running" && task.canRead) taskNotice.hidden = true;
    updateTaskUI();
  });
  updateTaskUI();
  function message(text) {
    notice.replaceChildren(
      el("span", {}, text),
      button("关闭", () => (notice.hidden = true)),
    );
    notice.hidden = false;
  }
  function transaction(store, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      const r = action(tx.objectStore(store));
      if (r) r.onsuccess = () => (result = r.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("存储操作已取消"));
    });
  }
  function persistBook() {
    if (!book || !db) return;
    const snapshot = structuredClone(book);
    write = write
      .catch(() => {})
      .then(() => transaction("books", "readwrite", (s) => s.put(snapshot)))
      .catch((e) => message("保存失败，请检查磁盘空间：" + e.message));
  }
  // Save small position records instead of rewriting a large novel while scrolling.
  function persistPosition() {
    if (!book || !db) return;
    const position = {
      kind: "reading-position", bookId: book.id, line: book.line || 0,
      offset: book.offset || 0, atTop: book.atTop === true, updated: book.updated,
    };
    write = write.catch(() => {}).then(() =>
      transaction("settings", "readwrite", (s) => s.put(position, "position:" + position.bookId)),
    ).catch((e) => message("阅读进度保存失败：" + e.message));
  }
  function persistSettings() {
    write = write
      .catch(() => {})
      .then(() =>
        transaction("settings", "readwrite", (s) =>
          s.put(settings, "preferences"),
        ),
      )
      .catch((e) => message("设置保存失败：" + e.message));
  }
  function appearance() {
    root.dataset.theme = settings.theme;
    root.style.setProperty(
      "--reader-font",
      settings.font === "sans"
        ? 'system-ui,"Microsoft YaHei",sans-serif'
        : '"Songti SC",SimSun,serif',
    );
    root.style.setProperty("--reader-size", settings.size + "px");
    root.style.setProperty("--reader-leading", settings.leading);
    if (settings.background)
      root.style.setProperty("--paper", settings.background);
    else root.style.removeProperty("--paper");
  }
  function checkpoint() {
    if (view !== "read" || !book || restoring || readingLocked) return;
    const paras = main.querySelectorAll("[data-line]");
    const top = main.getBoundingClientRect().top;
    let found;
    for (const p of paras) {
      if (p.getBoundingClientRect().bottom >= top) {
        found = p;
        break;
      }
    }
    found ??= paras[paras.length - 1];
    if (found) {
      book.line = Number(found.dataset.line);
      const rect = found.getBoundingClientRect();
      book.offset = Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height)));
    }
    book.atTop = main.scrollTop <= 1;
    book.updated = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistPosition, 350);
    updateFooterValues();
  }
  main.addEventListener("scroll", checkpoint, { passive: true });
  function updateFooter() {
    footer.replaceChildren();
    chapterSlider = chapterLabel = bookLabel = returnButton = undefined;
    if (!book) {
      footer.append("本地书架 · 内容仅存于此设备");
      return;
    }
    bookLabel = el("span", { class: "reading-context" });
    returnButton = button("返回跳转前", () => {
      const previous = jumpHistory.pop();
      if (!previous || previous.bookId !== book.id) return;
      const { bookId, ...position } = previous;
      Object.assign(book, position);
      view = "read";
      persistPosition();
      render();
    }, { class: "return-position", "aria-label": "返回上次跳转前的阅读位置" });
    if (view === "read") {
      chapterLabel = el("span", { class: "chapter-progress-label" });
      chapterSlider = el("input", {
        type: "range", min: 0, max: 1000, step: 1,
        "aria-label": "本章阅读进度",
        onPointerdown: () => { scrubOrigin = capturePosition(); },
        onInput: (e) => {
          const targetValue = Number(e.target.value);
          scrubOrigin ??= capturePosition();
          main.scrollTop = targetValue / 1000 * Math.max(0, main.scrollHeight - main.clientHeight);
          checkpoint();
        },
        onChange: () => {
          rememberPosition(scrubOrigin);
          scrubOrigin = undefined;
          checkpoint();
          persistPosition();
        },
      });
      footer.append(el("div", { class: "chapter-progress" }, chapterLabel, chapterSlider));
    }
    footer.append(el("div", { class: "reading-summary" }, bookLabel, returnButton));
    updateFooterValues();
  }
  function updateFooterValues() {
    if (!book || !bookLabel) return;
    const index = view === "read" ? readingChapter : chapterAt(book.line || 0);
    bookLabel.textContent = `第 ${index + 1} / ${toc.length} 章 · 全书 ${Math.round((book.line || 0) / Math.max(1, lines.length - 1) * 100)}%`;
    returnButton.hidden = !jumpHistory.length;
    if (!chapterSlider) return;
    const distance = Math.max(0, main.scrollHeight - main.clientHeight);
    const percent = distance > 1 ? Math.round(main.scrollTop / distance * 100) : 100;
    chapterLabel.textContent = `本章 ${percent}%`;
    chapterSlider.value = String(distance > 1 ? Math.round(main.scrollTop / distance * 1000) : 1000);
    chapterSlider.disabled = restoring || distance <= 1;
    chapterSlider.setAttribute("aria-valuetext", `本章 ${percent}%`);
  }
  function capturePosition() {
    checkpoint();
    return book && { bookId: book.id, line: book.line || 0, offset: book.offset || 0, atTop: book.atTop === true };
  }
  function rememberPosition(position) {
    if (!position || position.bookId !== book?.id) return;
    jumpHistory.push(position);
    if (jumpHistory.length > 20) jumpHistory.shift();
    updateFooterValues();
  }
  function chapterAt(line) {
    return Math.max(
      0,
      toc.findIndex((c) => line >= c.start && line < c.end),
    );
  }
  function open(b) {
    if (book) persistPosition();
    if (book?.id !== b.id) jumpHistory.length = 0;
    book = b;
    book.updated = Date.now();
    lines = book.text.split("\n");
    toc = C.chapters(book.text);
    view = "read";
    persistPosition();
    render();
  }
  function jump(line) {
    if (!book) return;
    rememberPosition(capturePosition());
    book.line = Math.max(0, Math.min(lines.length - 1, line));
    book.offset = 0;
    book.atTop = book.line === toc[chapterAt(book.line)].start;
    view = "read";
    persistPosition();
    render();
  }
  function render() {
    if (disposed) return;
    clearTimeout(searchTimer);
    cancelAnimationFrame(restoreFrame);
    const revision = ++renderRevision;
    restoring = view === "read" && !!book;
    scrubOrigin = undefined;
    appearance();
    nav.replaceChildren();
    for (const [id, title] of [
      ["shelf", "书架"],
      ["read", "阅读"],
      ["toc", "目录"],
      ["search", "搜索"],
      ["notes", "摘记"],
      ["settings", "外观"],
    ])
      nav.append(
        button(
          title,
          () => {
            checkpoint();
            view = id;
            render();
          },
          { "aria-pressed": String(view === id) },
        ),
      );
    main.replaceChildren();
    main.scrollTop = 0;
    if (view === "shelf") {
      main.append(
        el(
          "section",
          { class: "hero" },
          el("div", { class: "eyebrow" }, "YOUR PRIVATE LIBRARY"),
          el("h1", {}, "在字里行间，\n遇见另一个世界。"),
          el("p", { class: "muted" }, "导入一本好书，从上次停下的地方继续。"),
        ),
      );
      const filter = el("input", {
          type: "search",
          placeholder: "搜索书名…",
          "aria-label": "搜索书架",
        }),
        list = el("div");
      filter.addEventListener("input", () => shelfList(list, filter.value));
      main.append(filter, list);
      shelfList(list, "");
    } else if (view === "settings") {
      settingsView();
    } else if (!book) {
      main.append(
        el(
          "div",
          { class: "empty" },
          el("b", {}, "☷"),
          "先从书架选择一本书，或导入 TXT 文本。",
        ),
      );
    } else if (view === "read") {
      const index = chapterAt(book.line || 0),
        chapter = toc[index];
      readingChapter = index;
      const bar = el(
        "div",
        { class: "row" },
        el("small", {}, `第 ${index + 1} / ${toc.length} 章`),
        button("＋ 书签", () => addNote()),
        button("划线摘记", () => addNote(true)),
      );
      const article = el(
        "article",
        {},
        el("div", { class: "eyebrow" }, book.title),
        el("h2", chapter.heading ? { "data-line": chapter.start } : {},
          chapter.heading ? lines[chapter.start] : chapter.title),
      );
      main.append(bar, article);
      const fragment = document.createDocumentFragment();
      for (
        let i =
          chapter.start + (chapter.heading ? 1 : 0);
        i < chapter.end;
        i++
      ) {
        const p = el("p", {
          "data-line": i,
          class: book.notes.some((n) => n.line === i) ? "marked" : "",
        });
        const text = lines[i] || "\u00a0";
        if (
          query &&
          text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ) {
          let offset = 0,
            at;
          const lower = text.toLocaleLowerCase(),
            q = query.toLocaleLowerCase();
          while ((at = lower.indexOf(q, offset)) >= 0) {
            p.append(
              text.slice(offset, at),
              el("mark", {}, text.slice(at, at + query.length)),
            );
            offset = at + query.length;
          }
          p.append(text.slice(offset));
        } else p.textContent = text;
        fragment.append(p);
      }
      article.append(fragment);
      const chapterText = lines.slice(chapter.start, chapter.end).join("\n");
      const raw = el("details", { class: "chapter-source" },
        el("summary", {}, "查看本章原文"));
      raw.addEventListener("toggle", () => {
        if (raw.open && !raw.querySelector("pre")) raw.append(el("pre", {}, chapterText));
      });
      main.append(el("section", { class: "chapter-end", "aria-label": "章节末尾导航" },
        el("p", { class: "muted" }, `本章完 · ${chapterText.length.toLocaleString()} 字符`),
        el("div", { class: "chapter-navigation" },
          button("‹ 上一章", () => jump(toc[index - 1].start), index === 0 ? { disabled: "" } : {}),
          button(index < toc.length - 1 ? "下一章 ›" : "已读至全书末尾",
            () => jump(toc[index + 1].start),
            index < toc.length - 1 ? { class: "primary" } : { disabled: "" })),
        index < toc.length - 1 ? el("small", {}, `接下来：${toc[index + 1].title}`) : null,
        raw));
      const target = book.line || 0;
      const offset = book.offset || 0;
      const atTop = book.atTop === true;
      restoreFrame = requestAnimationFrame(() => {
        if (revision !== renderRevision || disposed) return;
        const targetElement = main.querySelector(`[data-line="${target}"]`);
        if (!atTop && targetElement && (target > chapter.start || offset > 0)) {
          const rect = targetElement.getBoundingClientRect();
          main.scrollTop += rect.top - main.getBoundingClientRect().top + rect.height * offset;
        } else main.scrollTop = 0;
        restoreFrame = requestAnimationFrame(() => {
          if (revision !== renderRevision || disposed) return;
          restoring = false;
          updateFooterValues();
        });
      });
    } else if (view === "toc") {
      main.append(
        el("h2", {}, book.title),
        el("p", { class: "muted" }, `${toc.length} 个章节 · ${book.encoding}`),
      );
      toc.forEach((c, i) =>
        main.append(
          button(`${i + 1}. ${c.title}`, () => jump(c.start), {
            class: "listitem",
            "aria-current": i === chapterAt(book.line) ? "true" : "false",
          }),
        ),
      );
    } else if (view === "search") {
      const field = el("input", {
          type: "search",
          value: query,
          placeholder: "搜索正文（最多显示 200 条）",
          "aria-label": "搜索正文",
        }),
        results = el("div");
      const show = () => {
        if (disposed || view !== "search") return;
        query = field.value.trim();
        results.replaceChildren();
        const hits = C.search(lines, query);
        results.append(
          el(
            "p",
            { class: "muted" },
            query
              ? `${hits.length}${hits.length === 200 ? "+" : ""} 条结果`
              : "输入文字开始搜索",
          ),
        );
        for (const hit of hits)
          results.append(
            button(
              `${toc[chapterAt(hit.line)].title} · ${hit.text.slice(Math.max(0, hit.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 30), Math.max(0, hit.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 30) + 160)}`,
              () => jump(hit.line),
              { class: "listitem" },
            ),
          );
      };
      field.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(show, 200);
      });
      main.append(field, results);
      show();
    } else if (view === "notes") {
      main.append(el("h2", {}, "书签与摘记"));
      if (!book.notes.length)
        main.append(
          el(
            "p",
            { class: "empty" },
            "阅读时添加书签，或选中文字后点击「划线摘记」。",
          ),
        );
      for (const n of book.notes) {
        const card = el(
          "section",
          { class: "card" },
          el(
            "div",
            { class: "info" },
            button(toc[chapterAt(n.line)].title, () => jump(n.line), {
              class: "listitem",
            }),
            el("p", { class: "note" }, n.quote),
            el("p", { class: "muted note" }, n.note || "阅读书签"),
            el("small", {}, new Date(n.created).toLocaleString()),
          ),
        );
        card.append(
          button("删除", () => {
            book.notes = book.notes.filter((x) => x.id !== n.id);
            persistBook();
            render();
          }),
        );
        main.append(card);
      }
    }
    updateFooter();
    updateTaskUI();
  }
  function shelfList(list, filter) {
    list.replaceChildren();
    const shown = books
      .filter((b) =>
        b.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
      )
      .sort((a, b) => b.updated - a.updated);
    if (!shown.length)
      list.append(
        el(
          "div",
          { class: "empty" },
          el("b", {}, "▤"),
          books.length ? "没有匹配的书籍" : "书架还是空的",
          el("p", {}, "支持 TXT / TEXT / MD，可拖放多个文件。"),
        ),
      );
    for (const b of shown) {
      const percent = Math.round(
        ((b.line || 0) / Math.max(1, b.text.split("\n").length - 1)) * 100,
      );
      list.append(
        el(
          "section",
          { class: "card" },
          el(
            "div",
            { class: "cover", "aria-hidden": "true" },
            Array.from(b.title)[0],
          ),
          el(
            "div",
            { class: "info" },
            el("span", { class: "title" }, b.title),
            el(
              "small",
              {},
              `${percent}% · ${Math.round(b.text.length / 1000)} 千字 · ${b.encoding}`,
            ),
            el("progress", { value: percent, max: 100 }),
          ),
          button("继续", () => open(b)),
          button(
            "移除",
            () => {
              if (
                !confirm(
                  `从本地书架移除《${b.title}》及其摘记？原文件不会删除。`,
                )
              )
                return;
              clearTimeout(saveTimer);
              write = write
                .catch(() => {})
                .then(() =>
                  transaction("books", "readwrite", (s) => s.delete(b.id)),
                )
                .then(() => {
                  books = books.filter((x) => x.id !== b.id);
                  if (book?.id === b.id) {
                    book = undefined;
                    lines = [];
                    toc = [];
                  }
                  render();
                })
                .catch((e) => message(e.message));
            },
            { class: "danger" },
          ),
        ),
      );
    }
  }
  function addNote(selection = false) {
    const selected = window.getSelection();
    let quote = "",
      line = book.line || 0;
    if (selection) {
      if (
        !selected ||
        !main.querySelector("article")?.contains(selected.anchorNode) ||
        !main.querySelector("article")?.contains(selected.focusNode) ||
        !selected.toString().trim()
      ) {
        message("请先选中正文中的文字。");
        return;
      }
      quote = selected.toString().slice(0, 10000);
      const anchor =
        selected.anchorNode.nodeType === 1
          ? selected.anchorNode
          : selected.anchorNode.parentElement;
      line = Number(anchor.closest("[data-line]")?.dataset.line ?? line);
    }
    view = "editor";
    render();
    const field = el("textarea", {
      rows: 5,
      maxlength: 5000,
      placeholder: "写下此刻的想法（可留空）",
      "aria-label": "摘记内容",
    });
    main.append(
      el("h2", {}, selection ? "划线摘记" : "添加书签"),
      el("p", { class: "note" }, quote || lines[line]?.slice(0, 200) || ""),
      field,
      el(
        "div",
        { class: "row" },
        button(
          "保存",
          () => {
            book.notes.push({
              id: crypto.randomUUID(),
              line,
              quote: quote || lines[line]?.slice(0, 200) || "",
              note: field.value,
              created: Date.now(),
            });
            persistBook();
            view = "read";
            render();
            message("已保存到摘记。");
          },
          { class: "primary" },
        ),
        button("取消", () => {
          view = "read";
          render();
        }),
      ),
    );
    field.focus();
  }
  function settingsView() {
    main.append(
      el("h2", {}, "让阅读更合心意"),
      el("p", { class: "muted" }, "设置自动保存，适用于整个本地书架。"),
      el("section", { class: "task-help" },
        el("strong", {}, "开发时读书，完成后回到项目"),
        el("p", {}, "顶部「联动专注」开启后，当前会话的一轮任务正常完成时会锁住小说。新的用户需求被 dsh 接受后自动解锁；等待确认、失败和手动停止会分别显示状态。"),
        el("small", {}, "可随时从顶部关闭联动专注。独立预览未连接 dsh 时保持正常阅读；页面内提醒不需要系统通知权限。")),
    );
    const stack = el("div", { class: "stack" });
    main.append(stack);
    function select(label, key, options) {
      const s = el("select", {
        "aria-label": label,
        onChange: (e) => {
          settings[key] = e.target.value;
          if (key === "theme") settings.background = "";
          appearance();
          persistSettings();
        },
      });
      for (const [value, title] of options)
        s.append(
          el(
            "option",
            { value, ...(settings[key] === value ? { selected: "" } : {}) },
            title,
          ),
        );
      stack.append(el("label", {}, label, s));
    }
    select("主题", "theme", [
      ["paper", "暖纸"],
      ["white", "素白"],
      ["green", "青竹"],
      ["night", "夜读"],
    ]);
    select("字体", "font", [
      ["serif", "宋体 / 衬线"],
      ["sans", "黑体 / 无衬线"],
    ]);
    for (const [key, label, min, max, step] of [
      ["size", "字号", 12, 32, 1],
      ["leading", "行距", 1.3, 2.8, 0.1],
    ]) {
      const output = el("span", {}, settings[key]);
      const slider = el("input", {
        type: "range",
        min,
        max,
        step,
        value: settings[key],
        "aria-label": label,
        onInput: (e) => {
          settings[key] = Number(e.target.value);
          output.textContent = settings[key];
          appearance();
          persistSettings();
        },
      });
      stack.append(el("label", {}, label, slider, output));
    }
    stack.append(
      el(
        "label",
        {},
        "自定义底色",
        el("input", {
          type: "color",
          value: settings.background || "#f7f3e9",
          "aria-label": "自定义背景颜色",
          onInput: (e) => {
            settings.background = e.target.value;
            appearance();
            persistSettings();
          },
        }),
      ),
    );
    select("下次导入编码", "encoding", [
      ["auto", "自动（UTF / GB18030）"],
      ["utf-8", "UTF-8"],
      ["gb18030", "GB18030 / GBK"],
      ["big5", "繁体 Big5"],
      ["utf-16le", "UTF-16 LE"],
      ["utf-16be", "UTF-16 BE"],
    ]);
    stack.append(
      el(
        "small",
        {},
        "自动识别不能覆盖所有旧文本；乱码时请选择编码后重新导入。单文件须小于 50 MB。",
      ),
      button("恢复默认外观", () => {
        settings = {
          ...settings,
          theme: "paper",
          font: "serif",
          size: 18,
          leading: 1.9,
          background: "",
        };
        persistSettings();
        render();
      }),
      button("导出本书摘记", () => {
        if (!book) {
          message("请先选择一本书。");
          return;
        }
        const blob = new Blob(
            [JSON.stringify({ title: book.title, notes: book.notes }, null, 2)],
            { type: "application/json" },
          ),
          url = URL.createObjectURL(blob),
          a = el("a", { href: url, download: book.title + "-摘记.json" });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
  }
  let importing = false;
  async function importFiles(files) {
    if (importing || !db) {
      message("请等待存储初始化或当前导入完成。");
      return;
    }
    importing = true;
    let count = 0;
    const errors = [];
    for (const file of Array.from(files)) {
      try {
        if (!/\.(txt|text|md)$/i.test(file.name))
          throw Error("仅支持 TXT、TEXT、MD 文本");
        if (file.size >= 50 * 1024 * 1024) throw Error("文件须小于 50 MB");
        const buffer = await file.arrayBuffer(),
          decoded = C.decode(buffer, settings.encoding);
        if (!decoded.text.trim()) throw Error("文件为空");
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
        )
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
        const existing = books.find((b) => b.id === hash);
        if (existing) {
          if (
            settings.encoding !== "auto" &&
            existing.encoding !== decoded.encoding
          ) {
            existing.text = decoded.text;
            existing.encoding = decoded.encoding;
            existing.line = Math.min(
              existing.line,
              decoded.text.split("\n").length - 1,
            );
            await transaction("books", "readwrite", (s) => s.put(existing));
            if (book?.id === existing.id) {
              book = existing;
              lines = book.text.split("\n");
              toc = C.chapters(book.text);
            }
            count++;
          } else errors.push(file.name + "：已在书架中");
          continue;
        }
        const b = {
          id: hash,
          title: file.name.replace(/\.[^.]+$/, ""),
          text: decoded.text,
          encoding: decoded.encoding,
          line: 0,
          updated: Date.now(),
          notes: [],
        };
        await transaction("books", "readwrite", (s) => s.put(b));
        books.push(b);
        count++;
      } catch (e) {
        errors.push(file.name + "：" + e.message);
      }
    }
    importing = false;
    if (!disposed) {
      view = "shelf";
      render();
      message(`已导入 ${count} 本。${errors.join("；")}`);
    }
  }
  const onDragOver = (e) => {
    e.preventDefault();
    root.classList.add("drop");
  };
  const onDragLeave = () => root.classList.remove("drop");
  const onDrop = (e) => {
    e.preventDefault();
    root.classList.remove("drop");
    importFiles(e.dataTransfer.files);
  };
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);
  const unload = () => {
    clearTimeout(saveTimer);
    checkpoint();
    clearTimeout(saveTimer);
    persistPosition();
  };
  window.addEventListener("pagehide", unload);
  const resizeObserver = new ResizeObserver(updateFooterValues);
  resizeObserver.observe(main);
  // Keep the legacy storage key across renames so existing books, notes and progress remain available.
  const request = indexedDB.open("dsh-novel-reader-v1", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("books", { keyPath: "id" });
    request.result.createObjectStore("settings");
  };
  request.onerror = () => message("无法打开本地书架：" + request.error.message);
  request.onsuccess = async () => {
    db = request.result;
    if (disposed) {
      db.close();
      return;
    }
    db.onversionchange = () => {
      db.close();
      message("书架版本已变更，请重新打开阅读器。");
    };
    try {
      books = await transaction("books", "readonly", (s) => s.getAll());
      const saved = await transaction("settings", "readonly", (s) =>
        s.get("preferences"),
      );
      if (saved) settings = { ...settings, ...saved };
      const positions = await transaction("settings", "readonly", (s) => s.getAll());
      const byId = new Map(books.map((b) => [b.id, b]));
      for (const position of positions) {
        const b = position.kind === "reading-position" && byId.get(position.bookId);
        if (!b) continue;
        b.line = Math.max(0, Math.min(b.text.split("\n").length - 1, Number(position.line) || 0));
        b.offset = Math.max(0, Math.min(1, Number(position.offset) || 0));
        b.atTop = position.atTop === true;
        b.updated = position.updated || b.updated;
      }
      render();
    } catch (e) {
      message("书架加载失败：" + e.message);
    }
  };
  main.append(el("div", { class: "empty" }, "正在打开本地书架…"));
  return () => {
    checkpoint();
    disposed = true;
    stopTask?.();
    clearTimeout(saveTimer);
    clearTimeout(searchTimer);
    cancelAnimationFrame(restoreFrame);
    persistPosition();
    window.removeEventListener("pagehide", unload);
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("dragleave", onDragLeave);
    root.removeEventListener("drop", onDrop);
    resizeObserver.disconnect();
    write.finally(() => db?.close());
    root.replaceChildren();
  };
}

function apply(ctx){
function Reader({sessionId}){
  const ref=React.useRef(null),source=React.useRef(null);
  React.useEffect(()=>{
    const taskSource=ZhijianReaderTaskLink.createSource(ctx,sessionId);
    source.current=taskSource;
    const unmount=mountReader(ref.current,{taskSource});
    return()=>{source.current=null;unmount();taskSource.dispose();};
  },[]);
  React.useEffect(()=>{source.current?.setSession(sessionId);},[sessionId]);
  return React.createElement('div',{ref,style:{height:'100%',minHeight:0,flex:1}});
}
ctx.effect(()=>{const style=document.createElement('style');style.textContent=".nr {\n  --paper: #f7f3e9;\n  --ink: #353c35;\n  --muted: #7d8375;\n  --line: #dedfd2;\n  --accent: #52715a;\n  box-sizing: border-box;\n  height: 100%;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  background: var(--paper);\n  color: var(--ink);\n  font:\n    13px/1.5 system-ui,\n    \"Microsoft YaHei\",\n    sans-serif;\n  container-type: inline-size;\n}\n.nr * {\n  box-sizing: border-box;\n}\n.nr[data-theme=\"night\"] {\n  --paper: #202722;\n  --ink: #d5dccd;\n  --muted: #a1ad9c;\n  --line: #3a473c;\n  --accent: #aac59b;\n}\n.nr[data-theme=\"white\"] {\n  --paper: #fff;\n  --ink: #323a40;\n  --muted: #707981;\n  --line: #e3e7eb;\n  --accent: #476d89;\n}\n.nr[data-theme=\"green\"] {\n  --paper: #e8f0e2;\n  --ink: #34432f;\n  --muted: #6e8166;\n  --line: #ccd9c4;\n  --accent: #4e7041;\n}\n.nr button,\n.nr select,\n.nr input,\n.nr textarea {\n  font: inherit;\n  color: inherit;\n}\n.nr button {\n  cursor: pointer;\n  border: 1px solid var(--line);\n  background: transparent;\n  border-radius: 9px;\n  padding: 7px 10px;\n}\n.nr button:hover {\n  background: color-mix(in srgb, var(--accent) 12%, transparent);\n}\n.nr button:disabled {\n  opacity: 0.4;\n  cursor: default;\n}\n.nr button:focus-visible,\n.nr input:focus-visible,\n.nr select:focus-visible {\n  outline: 2px solid var(--accent);\n  outline-offset: 2px;\n}\n.nr .primary {\n  background: var(--accent);\n  color: var(--paper);\n  border-color: var(--accent);\n}\n.nr header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  padding: 17px 18px 10px;\n}\n.nr .brand {\n  font-size: 17px;\n  font-weight: 650;\n  letter-spacing: 2px;\n}\n.nr small,\n.nr .muted {\n  color: var(--muted);\n}\n.nr nav {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 5px;\n  padding: 8px 14px;\n  border-bottom: 1px solid var(--line);\n}\n.nr nav button {\n  border: 0;\n  padding: 6px 9px;\n}\n.nr nav button[aria-pressed=\"true\"] {\n  background: var(--accent);\n  color: var(--paper);\n}\n.nr main {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  overscroll-behavior: contain;\n  padding: 20px;\n}\n.nr .reader-stage {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  position: relative;\n}\n.nr .task-bar {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 10px 14px;\n  border-bottom: 1px solid var(--line);\n  background: color-mix(in srgb, var(--accent) 5%, var(--paper));\n}\n.nr .task-context { flex: 1; min-width: 0; }\n.nr .task-status { display: block; font-size: 12px; font-weight: 600; }\n.nr .task-status::before {\n  content: \"\";\n  display: inline-block;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  margin-right: 7px;\n  background: var(--muted);\n}\n.nr .task-bar[data-phase=\"running\"] .task-status::before,\n.nr .task-bar[data-phase=\"completed\"] .task-status::before { background: var(--accent); }\n.nr .task-bar[data-phase=\"waiting\"] .task-status::before,\n.nr .task-bar[data-phase=\"error\"] .task-status::before { background: #b07837; }\n.nr .task-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; margin-top: 2px; }\n.nr .task-focus { flex-shrink: 0; font-size: 11px; padding: 6px 9px; }\n.nr .task-focus[aria-pressed=\"true\"] { background: var(--accent); color: var(--paper); border-color: var(--accent); }\n.nr .task-notice {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 12px 14px;\n  border-bottom: 1px solid var(--line);\n  background: color-mix(in srgb, var(--accent) 13%, var(--paper));\n}\n.nr .task-notice > div { flex: 1; min-width: 0; }\n.nr .task-notice strong { font-size: 13px; }\n.nr .task-notice p { margin: 3px 0 0; font-size: 11px; }\n.nr .task-notice button { flex-shrink: 0; font-size: 11px; }\n.nr .focus-lock {\n  position: absolute;\n  inset: 0;\n  display: grid;\n  align-items: center;\n  overflow: auto;\n  padding: 28px 24px;\n  text-align: center;\n  background: var(--paper);\n}\n.nr .task-locked main { visibility: hidden; }\n.nr .lock-card { max-width: 320px; margin: auto; }\n.nr .lock-mark { display: grid; place-items: center; width: 52px; height: 52px; border: 1px solid var(--line); border-radius: 18px; color: var(--accent); font-size: 23px; margin: 0 auto 22px; }\n.nr .focus-lock h2 { font: 500 22px/1.5 \"Songti SC\",SimSun,serif; margin: 12px 0; }\n.nr .focus-lock p { line-height: 1.9; color: var(--muted); margin-bottom: 24px; }\n.nr .focus-lock small { font-size: 11px; }\n.nr .task-help { margin: 18px 0 24px; padding: 15px; border: 1px solid var(--line); border-radius: 12px; }\n.nr .task-help p { color: var(--muted); line-height: 1.8; }\n.nr .hero {\n  padding: 32px 4px 24px;\n}\n.nr .eyebrow {\n  font-size: 10px;\n  letter-spacing: 3px;\n  color: var(--accent);\n}\n.nr h1 {\n  font:\n    500 29px/1.4 Georgia,\n    \"Songti SC\",\n    SimSun,\n    serif;\n  margin: 10px 0;\n}\n.nr h2 {\n  font-size: 17px;\n  font-weight: 550;\n}\n.nr .card {\n  display: flex;\n  gap: 13px;\n  padding: 15px 0;\n  border-bottom: 1px solid var(--line);\n  align-items: center;\n}\n.nr .cover {\n  width: 44px;\n  height: 61px;\n  border-radius: 3px 7px 7px 3px;\n  background: var(--accent);\n  color: var(--paper);\n  display: grid;\n  place-items: center;\n  box-shadow: inset 4px 0 #ffffff20;\n  font: 22px SimSun;\n  flex-shrink: 0;\n}\n.nr .card .info {\n  flex: 1;\n  min-width: 0;\n}\n.nr .title {\n  display: block;\n  overflow-wrap: anywhere;\n  font-weight: 600;\n}\n.nr .row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n.nr .stack {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n.nr input:not([type=\"range\"]):not([type=\"color\"]),\n.nr textarea,\n.nr select {\n  border: 1px solid var(--line);\n  border-radius: 8px;\n  background: var(--paper);\n  padding: 9px;\n  max-width: 100%;\n}\n.nr input[type=\"search\"] {\n  width: 100%;\n}\n.nr .empty {\n  padding: 46px 12px;\n  text-align: center;\n  color: var(--muted);\n}\n.nr .empty b {\n  font-size: 38px;\n  color: var(--accent);\n  display: block;\n  font-weight: 400;\n}\n.nr .listitem {\n  display: block;\n  width: 100%;\n  text-align: left;\n  border: 0;\n  border-bottom: 1px solid var(--line);\n  border-radius: 0;\n  padding: 12px 4px;\n}\n.nr article {\n  max-width: 760px;\n  margin: auto;\n  font-family: var(--reader-font, SimSun, serif);\n  font-size: var(--reader-size, 18px);\n  line-height: var(--reader-leading, 1.9);\n  overflow-wrap: anywhere;\n}\n.nr article h2 {\n  font-family: inherit;\n  font-size: 1.25em;\n  font-weight: 600;\n  line-height: 1.5;\n  margin: 10px 0 28px;\n}\n.nr article p {\n  white-space: pre-wrap;\n  text-indent: 2em;\n  margin: 0.7em 0;\n  scroll-margin-top: 20px;\n}\n.nr article p.marked {\n  background: color-mix(in srgb, var(--accent) 18%, transparent);\n  border-left: 2px solid var(--accent);\n}\n.nr mark {\n  background: #eedc8a;\n  color: #292c21;\n}\n.nr footer {\n  padding: 9px 14px;\n  border-top: 1px solid var(--line);\n  display: flex;\n  flex-direction: column;\n  gap: 5px;\n  align-items: stretch;\n  font-size: 11px;\n  color: var(--muted);\n}\n.nr .chapter-progress, .nr .reading-summary {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  min-width: 0;\n}\n.nr .chapter-progress-label { white-space: nowrap; min-width: 64px; font-variant-numeric: tabular-nums; }\n.nr .reading-summary { justify-content: space-between; flex-wrap: wrap; }\n.nr .return-position { font-size: 11px; padding: 3px 7px; }\n.nr .chapter-end { max-width: 760px; margin: 32px auto 8px; border-top: 1px solid var(--line); padding-top: 20px; text-align: center; }\n.nr .chapter-navigation { display: flex; gap: 12px; margin: 16px 0 10px; }\n.nr .chapter-navigation button { flex: 1; padding: 13px; }\n.nr .chapter-end > small { display: block; overflow-wrap: anywhere; }\n.nr .chapter-source { text-align: left; margin-top: 24px; color: var(--muted); }\n.nr .chapter-source summary { cursor: pointer; }\n.nr .chapter-source pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.9; color: var(--ink); }\n.nr article h2 { white-space: pre-wrap; }\n.nr footer input {\n  width: 100%;\n  min-width: 40px;\n  accent-color: var(--accent);\n}\n.nr .notice {\n  padding: 9px 14px;\n  background: #ab572015;\n  color: var(--ink);\n  display: flex;\n  gap: 8px;\n  align-items: center;\n}\n.nr .notice span {\n  flex: 1;\n}\n.nr label {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  gap: 12px;\n}\n.nr progress {\n  width: 100%;\n  height: 3px;\n  accent-color: var(--accent);\n}\n.nr .note {\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n.nr .danger {\n  color: #b15340;\n}\n.nr .drop {\n  outline: 2px dashed var(--accent);\n  outline-offset: -8px;\n}\n@container (max-width:340px) {\n  .nr header {\n    padding: 12px;\n  }\n  .nr main {\n    padding: 14px;\n  }\n  .nr nav {\n    gap: 0;\n    padding: 6px;\n  }\n  .nr nav button {\n    padding: 6px 7px;\n  }\n  .nr .card {\n    flex-wrap: wrap;\n  }\n  .nr .brand {\n    font-size: 15px;\n  }\n}\n\n.nr [hidden] {\n  display: none !important;\n}\n.nr textarea {\n  width: 100%;\n  resize: vertical;\n  min-height: 120px;\n}\n";document.head.append(style);return()=>style.remove();});ctx.effect(()=>ctx.sidebarRightTabs.register({id:'dsh-zhijian-reader',kind:'dsh-zhijian-reader',multiple:false,priority:'extension',title:()=>'纸间 · 小说阅读器',guide:[{id:'new',order:35,title:()=>'纸间 · 小说阅读器',description:()=>'本地书架 · 开发任务联动',icon:()=>React.createElement('span',{'aria-hidden':true},'▤')}]}));ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:'dsh-zhijian-reader'},Reader)));}return {inject:['slots','sidebarRightTabs','sessions','uiSession'],apply};}});
