// Browser-only development harness. This file is excluded from the plugin package.
function createPreviewTaskSource() {
  if (!new URLSearchParams(location.search).has("task-demo")) return;
  function store(value) {
    const listeners = new Set();
    return {
      getSnapshot: () => value,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      set(next) { value = next; for (const listener of [...listeners]) listener(); },
    };
  }
  const sessionId = "preview-development";
  let seq = 0, revision = 0, turn = 0;
  const session = store({ openState: "open", running: false }),
    eventSource = store({ entries: [], revision: 0, change: { kind: "replace", entries: [] } }),
    status = store(new Map([[sessionId, { running: false }]])),
    list = store({ phase: "ready", byId: { [sessionId]: { displayTitle: "模拟开发项目（仅预览）", running: false } } }),
    binding = { session, eventSource };
  const source = NovelReaderTaskLink.createSource({
    sessions: { list, binding: (id) => id === sessionId ? binding : undefined },
    uiSession: { sessionStatus: status },
  }, sessionId);
  source.preview = true;
  function append(type, data, extra = {}) {
    const entry = { type: "event", event: { type, data, seq: ++seq, ...extra } };
    eventSource.set({ entries: [...eventSource.getSnapshot().entries, entry], revision: ++revision, change: { kind: "append", entries: [entry] } });
  }
  function running(value, waiting = false) {
    session.set({ openState: "open", running: value });
    status.set(new Map([[sessionId, { running: value, pendingInteraction: waiting ? { kind: "approval" } : undefined }]]));
  }
  const controls = document.createElement("aside");
  controls.className = "preview-controls";
  controls.setAttribute("aria-label", "预览任务模拟器");
  const label = document.createElement("strong");
  label.textContent = "预览模拟器 · 不连接或执行真实 dsh 任务";
  controls.append(label);
  const actions = {
    "提交新需求": () => { append("user/message", { source: { kind: "user" } }, { surfaceOp: "append" }); append("turn/start", { turn: ++turn }); running(true); },
    "等待确认": () => running(true, true),
    "继续执行": () => running(true),
    "正常完成": () => { append("turn/end", { turn, reason: { kind: "completed" } }); running(false); },
    "手动停止": () => { append("turn/end", { turn, reason: { kind: "aborted" } }); running(false); },
    "执行出错": () => { append("turn/end", { turn, reason: { kind: "error" } }); running(false); },
    "自动续跑": () => { append("turn/start", { turn: ++turn }); running(true); },
  };
  for (const [text, action] of Object.entries(actions)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", action);
    controls.append(button);
  }
  document.body.prepend(controls);
  return source;
}
