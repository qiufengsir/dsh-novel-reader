const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSource } = require("../src/task-link.cjs");

function store(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function event(seq, type, data = {}, extra = {}) {
  return { type: "event", event: { seq, time: seq * 1000, type, data, ...extra } };
}
function prompt(seq, kind = "user", surfaceOp = "append") {
  return event(seq, "user/message", {
    source: { kind, rpcId: `request-${seq}` },
    content: [{ type: "text", text: "继续开发这个项目" }],
  }, { surfaceOp });
}
function start(seq, turn = 1) {
  return event(seq, "turn/start", { turn });
}
function end(seq, kind = "completed", turn = 1) {
  return event(seq, "turn/end", {
    turn,
    reason: kind === "error"
      ? { kind, error: { message: "测试请求失败", code: "TEST_FAILURE" } }
      : kind === "aborted"
        ? { kind, reason: { kind: "user" } }
        : { kind },
  });
}

function harness(options = {}) {
  const ids = options.ids || ["project-a", "project-b", "child-a"];
  const bindings = new Map();
  const stores = [];
  for (const id of ids) {
    const initial = options.initial?.[id] || {};
    const session = store({
      sessionId: id,
      running: false,
      removed: false,
      openState: "open",
      openError: null,
      lastAgentError: null,
      pendingSubmissions: [],
      ...initial.session,
    });
    const entries = initial.entries || [];
    const eventSource = store({
      entries,
      hasMore: false,
      revision: 1,
      change: { kind: "replace", entries },
    });
    stores.push(session, eventSource);
    bindings.set(id, { sessionId: id, session, eventSource, ctx: {} });
  }
  const list = store({
    phase: "ready",
    ids,
    byId: Object.fromEntries(ids.map((id) => [id, {
      id,
      displayTitle: id === "project-a" ? "正在开发的项目" : id,
      running: !!options.initial?.[id]?.session?.running,
    }])),
  });
  const current = store({ key: options.current || "project-a" });
  const sessionStatus = store(new Map(ids.map((id) => [id, {
    running: !!options.initial?.[id]?.session?.running,
    pendingInteraction: undefined,
  }])));
  stores.push(list, current, sessionStatus);
  const ctx = {
    sessions: { list, binding: (id) => bindings.get(id) },
    uiSession: { adapter: { current }, sessionStatus },
  };
  function updateSession(id, patch) {
    const binding = bindings.get(id);
    binding.session.set({ ...binding.session.getSnapshot(), ...patch });
  }
  function running(id, value) {
    updateSession(id, { running: value });
    const previous = list.getSnapshot();
    list.set({ ...previous, byId: {
      ...previous.byId,
      [id]: { ...previous.byId[id], running: value },
    } });
    const statuses = new Map(sessionStatus.getSnapshot());
    statuses.set(id, { ...statuses.get(id), running: value });
    sessionStatus.set(statuses);
  }
  function change(id, kind, additions) {
    const source = bindings.get(id).eventSource;
    const previous = source.getSnapshot();
    const entries = kind === "replace" ? additions : kind === "prepend"
      ? [...additions, ...previous.entries]
      : [...previous.entries, ...additions];
    source.set({ entries, hasMore: false, revision: previous.revision + 1,
      change: { kind, entries: additions } });
  }
  return {
    ctx, bindings, list, current, sessionStatus, updateSession, running,
    append: (id, entry) => change(id, "append", [entry]),
    replace: (id, entries) => change(id, "replace", entries),
    prepend: (id, entries) => change(id, "prepend", entries),
    pending(id, interaction) {
      const statuses = new Map(sessionStatus.getSnapshot());
      statuses.set(id, { ...statuses.get(id), pendingInteraction: interaction });
      sessionStatus.set(statuses);
    },
    listenerCount: () => stores.reduce((sum, item) => sum + item.listenerCount, 0),
  };
}

function begin(h, id = "project-a", seq = 1, turn = 1) {
  h.append(id, prompt(seq));
  h.append(id, start(seq + 1, turn));
  h.running(id, true);
}
function complete(h, id = "project-a", seq = 3, turn = 1, kind = "completed") {
  h.append(id, end(seq, kind, turn));
  h.running(id, false);
}

test("task linkage is optional and missing services leave standalone reading available", () => {
  const source = createSource({});
  assert.equal(source.getSnapshot().phase, "unlinked");
  assert.equal(source.getSnapshot().canRead, true);
  source.dispose();
});

test("opening completed history establishes a quiet baseline instead of a new completion", () => {
  const h = harness({ initial: { "project-a": { entries: [prompt(1), start(2), end(3)] } } });
  const source = createSource(h.ctx, "project-a");
  const snapshot = source.getSnapshot();
  assert.equal(snapshot.sessionId, "project-a");
  assert.equal(snapshot.title, "正在开发的项目");
  assert.equal(snapshot.phase, "completed");
  assert.equal(snapshot.noticeId, 0);
  assert.equal(snapshot.canRead, false);
  source.dispose();
});

test("a user request unlocks reading and a normal completed turn closes it with one notice", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  assert.equal(source.getSnapshot().canRead, false);
  begin(h);
  assert.equal(source.getSnapshot().phase, "running");
  assert.equal(source.getSnapshot().canRead, true);
  complete(h);
  const finished = source.getSnapshot();
  assert.equal(finished.phase, "completed");
  assert.equal(finished.canRead, false);
  assert.equal(finished.noticeId, 1);
  h.running("project-a", false);
  assert.equal(source.getSnapshot().noticeId, 1);
  source.dispose();
});

test("a session already running when the reader opens remains readable without an old notice", () => {
  const h = harness({ initial: { "project-a": {
    entries: [prompt(1), start(2)], session: { running: true },
  } } });
  const source = createSource(h.ctx, "project-a");
  assert.equal(source.getSnapshot().phase, "running");
  assert.equal(source.getSnapshot().canRead, true);
  assert.equal(source.getSnapshot().noticeId, 0);
  complete(h);
  assert.equal(source.getSnapshot().noticeId, 1);
  assert.equal(source.getSnapshot().canRead, false);
  source.dispose();
});

test("opening a running session works when the paged history no longer contains its user prompt", () => {
  const h = harness({ initial: { "project-a": {
    entries: [event(100, "tool/result", { callId: "long-running-build" })],
    session: { running: true },
  } } });
  const source = createSource(h.ctx, "project-a");
  assert.equal(source.getSnapshot().phase, "running");
  assert.equal(source.getSnapshot().canRead, true);
  assert.equal(source.getSnapshot().noticeId, 0);
  complete(h, "project-a", 101);
  assert.equal(source.getSnapshot().phase, "completed");
  assert.equal(source.getSnapshot().canRead, false);
  h.append("project-a", start(102, 2));
  h.running("project-a", true);
  assert.equal(source.getSnapshot().canRead, false);
  source.dispose();
});

test("waiting for user interaction is distinct from completed", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  h.pending("project-a", { sessionId: "project-a", kind: "approval" });
  assert.equal(source.getSnapshot().phase, "waiting");
  assert.equal(source.getSnapshot().noticeId, 0);
  h.pending("project-a", undefined);
  assert.equal(source.getSnapshot().phase, "running");
  complete(h);
  assert.equal(source.getSnapshot().phase, "completed");
  source.dispose();
});

for (const [reason, phase] of [["error", "error"], ["aborted", "stopped"], ["interrupted", "stopped"], ["max-tokens", "stopped"]]) {
  test(`${reason} produces ${phase}, never a successful completion`, () => {
    const h = harness();
    const source = createSource(h.ctx, "project-a");
    begin(h);
    complete(h, "project-a", 3, 1, reason);
    assert.equal(source.getSnapshot().phase, phase);
    assert.equal(source.getSnapshot().noticeId, 1);
    source.dispose();
  });
}

test("a running status drop without a durable completed event cannot claim success", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  h.running("project-a", false);
  assert.notEqual(source.getSnapshot().phase, "completed");
  assert.equal(source.getSnapshot().noticeId, 0);
  source.dispose();
});

test("automatic turns and nonhuman messages do not unlock a completed focus gate", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  complete(h);
  h.append("project-a", prompt(4, "goal"));
  h.append("project-a", start(5, 2));
  h.running("project-a", true);
  assert.equal(source.getSnapshot().canRead, false);
  h.append("project-a", prompt(6, "user", "replace"));
  assert.equal(source.getSnapshot().canRead, false);
  h.append("project-a", prompt(7));
  assert.equal(source.getSnapshot().canRead, true);
  source.dispose();
});

for (const reason of ["error", "aborted", "interrupted"]) {
  test(`an automatic ${reason} cannot reopen reading locked by a previous completed turn`, () => {
    const h = harness();
    const source = createSource(h.ctx, "project-a");
    begin(h);
    complete(h);
    h.append("project-a", start(4, 2));
    h.running("project-a", true);
    complete(h, "project-a", 5, 2, reason);
    assert.equal(source.getSnapshot().canRead, false);
    assert.equal(source.getSnapshot().phase, reason === "error" ? "error" : "stopped");
    source.dispose();
  });
}

for (const failure of ["lastAgentError", "openError"]) {
  test(`a ${failure} cannot reopen reading locked by a previous completed turn`, () => {
    const h = harness();
    const source = createSource(h.ctx, "project-a");
    begin(h);
    complete(h);
    h.append("project-a", start(4, 2));
    h.running("project-a", true);
    h.updateSession("project-a", { [failure]: "自动执行失败" });
    assert.equal(source.getSnapshot().phase, "error");
    assert.equal(source.getSnapshot().canRead, false);
    source.dispose();
  });
}

for (const reason of ["error", "aborted"]) {
  test(`an accepted new requirement keeps reading available if its own turn ends with ${reason}`, () => {
    const h = harness();
    const source = createSource(h.ctx, "project-a");
    begin(h);
    complete(h);
    begin(h, "project-a", 4, 2);
    complete(h, "project-a", 6, 2, reason);
    assert.equal(source.getSnapshot().canRead, true);
    assert.equal(source.getSnapshot().phase, reason === "error" ? "error" : "stopped");
    source.dispose();
  });
}

test("an accepted new requirement stays readable after a live runtime failure", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  complete(h);
  begin(h, "project-a", 4, 2);
  h.updateSession("project-a", { lastAgentError: "新一轮连接失败" });
  assert.equal(source.getSnapshot().phase, "error");
  assert.equal(source.getSnapshot().canRead, true);
  source.dispose();
});

test("an accepted queued user requirement unlocks while the next turn is being admitted", () => {
  const h = harness({ initial: { "project-a": { entries: [prompt(1), start(2), end(3)] } } });
  const source = createSource(h.ctx, "project-a");
  h.append("project-a", event(4, "agent/inbox/spliced", {
    target: "next-turn", start: 0, removedCount: 0,
    inserted: [{ source: { kind: "user", rpcId: "accepted-4" }, content: [{ type: "text", text: "新的需求" }] }],
  }));
  assert.equal(source.getSnapshot().canRead, true);
  h.append("project-a", start(5, 2));
  h.running("project-a", true);
  assert.equal(source.getSnapshot().phase, "running");
  source.dispose();
});

test("local prompt echoes and rejected submissions cannot unlock completed reading", () => {
  const h = harness({ initial: { "project-a": { entries: [prompt(1), start(2), end(3)] } } });
  const source = createSource(h.ctx, "project-a");
  h.updateSession("project-a", { pendingSubmissions: [{ requestId: "optimistic", text: "未被接受的需求", placement: "transcript" }] });
  assert.equal(source.getSnapshot().canRead, false);
  h.updateSession("project-a", { pendingSubmissions: [], promptError: new Error("发送失败") });
  assert.equal(source.getSnapshot().canRead, false);
  source.dispose();
});

test("older history, assistant settlement, and reconnect replay cannot duplicate a notice", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h, "project-a", 10);
  complete(h, "project-a", 12);
  h.prepend("project-a", [prompt(1), start(2), end(3)]);
  assert.equal(source.getSnapshot().noticeId, 1);
  const feed = h.bindings.get("project-a").eventSource;
  const previous = feed.getSnapshot();
  feed.set({ ...previous, revision: previous.revision + 1,
    change: { kind: "settle-assistant", attemptId: "stream-1" } });
  assert.equal(source.getSnapshot().noticeId, 1);
  h.replace("project-a", feed.getSnapshot().entries);
  assert.equal(source.getSnapshot().noticeId, 1);
  h.append("project-a", end(12));
  assert.equal(source.getSnapshot().noticeId, 1);
  assert.equal(source.getSnapshot().canRead, false);
  source.dispose();
});

test("reconnect with a truncated automatic turn cannot erase a completion observed by this source", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h, "project-a", 10);
  complete(h, "project-a", 12);
  h.append("project-a", start(13, 2));
  h.running("project-a", true);
  h.replace("project-a", [event(100, "tool/result", { callId: "automatic-run" })]);
  assert.equal(source.getSnapshot().canRead, false);
  assert.equal(source.getSnapshot().noticeId, 1);
  source.dispose();
});

test("an observed new requirement survives tail replacement that omits its accepted user event", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  complete(h);
  h.append("project-a", prompt(4));
  h.append("project-a", start(5, 2));
  h.running("project-a", true);
  h.replace("project-a", [event(100, "tool/result", { callId: "build-2" })]);
  assert.equal(source.getSnapshot().canRead, true);
  assert.equal(source.getSnapshot().noticeId, 1);
  source.dispose();
});

test("an old completion replay after an empty reconnect window cannot notify twice", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h, "project-a", 10);
  complete(h, "project-a", 12);
  h.replace("project-a", []);
  h.append("project-a", end(12));
  assert.equal(source.getSnapshot().noticeId, 1);
  assert.equal(source.getSnapshot().canRead, false);
  source.dispose();
});

test("an older completed window cannot override a newer requirement observed by this source", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  complete(h);
  h.append("project-a", prompt(4));
  h.append("project-a", start(5, 2));
  h.running("project-a", true);
  h.replace("project-a", [prompt(1), start(2), end(3)]);
  assert.equal(source.getSnapshot().phase, "running");
  assert.equal(source.getSnapshot().canRead, true);
  assert.equal(source.getSnapshot().noticeId, 1);
  source.dispose();
});

test("a completed baseline followed by an automatic turn stays locked even when running", () => {
  const h = harness({ initial: { "project-a": {
    entries: [prompt(1), start(2), end(3), start(4, 2)],
    session: { running: true },
  } } });
  const source = createSource(h.ctx, "project-a");
  assert.equal(source.getSnapshot().phase, "running");
  assert.equal(source.getSnapshot().canRead, false);
  assert.equal(source.getSnapshot().noticeId, 0);
  source.dispose();
});

test("a live agent failure without a turn position has one failure notice and accepts recovery", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  h.updateSession("project-a", { lastAgentError: "模型连接中断" });
  assert.equal(source.getSnapshot().phase, "error");
  assert.equal(source.getSnapshot().noticeId, 1);
  h.updateSession("project-a", { lastAgentError: "模型连接中断" });
  assert.equal(source.getSnapshot().noticeId, 1);
  h.updateSession("project-a", { lastAgentError: null });
  h.append("project-a", prompt(3));
  h.append("project-a", start(4, 2));
  assert.equal(source.getSnapshot().phase, "running");
  assert.equal(source.getSnapshot().canRead, true);
  source.dispose();
});

test("a failure already present on attachment is a quiet failure baseline", () => {
  const h = harness({ initial: { "project-a": {
    session: { lastAgentError: "已有的失败" },
  } } });
  const source = createSource(h.ctx, "project-a");
  assert.equal(source.getSnapshot().phase, "error");
  assert.equal(source.getSnapshot().noticeId, 0);
  source.dispose();
});

test("other projects and child sessions cannot finish or unlock a pinned project", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  begin(h, "child-a");
  complete(h, "child-a");
  begin(h, "project-b");
  complete(h, "project-b");
  assert.equal(source.getSnapshot().phase, "running");
  assert.equal(source.getSnapshot().noticeId, 0);
  complete(h);
  begin(h, "project-b", 4, 2);
  h.current.set({ key: "project-b" });
  assert.equal(source.getSnapshot().sessionId, "project-a");
  assert.equal(source.getSnapshot().canRead, false);
  source.dispose();
});

test("following the current session switches its baseline quietly and stops observing the old one", () => {
  const h = harness({ initial: { "project-b": { entries: [prompt(1), start(2), end(3)] } } });
  const source = createSource(h.ctx);
  begin(h);
  h.current.set({ key: "project-b" });
  assert.equal(source.getSnapshot().sessionId, "project-b");
  assert.equal(source.getSnapshot().phase, "completed");
  assert.equal(source.getSnapshot().noticeId, 0);
  complete(h);
  assert.equal(source.getSnapshot().sessionId, "project-b");
  assert.equal(source.getSnapshot().noticeId, 0);
  assert.equal(h.bindings.get("project-a").eventSource.listenerCount, 0);
  source.dispose();
});

test("switching away and back preserves an observed completed gate for the same project", () => {
  const h = harness();
  const source = createSource(h.ctx);
  begin(h);
  complete(h);
  h.current.set({ key: "project-b" });
  h.append("project-a", start(4, 2));
  h.running("project-a", true);
  h.replace("project-a", [event(100, "tool/result", { callId: "automatic-run" })]);
  h.current.set({ key: "project-a" });
  assert.equal(source.getSnapshot().sessionId, "project-a");
  assert.equal(source.getSnapshot().canRead, false);
  assert.equal(source.getSnapshot().noticeId, 1);
  source.dispose();
});

test("the explicit session setter retargets a preserved source without keeping old listeners", () => {
  const h = harness();
  const source = createSource(h.ctx, "project-a");
  begin(h);
  source.setSession("project-b");
  assert.equal(source.getSnapshot().sessionId, "project-b");
  assert.equal(h.bindings.get("project-a").eventSource.listenerCount, 0);
  begin(h, "project-b");
  assert.equal(source.getSnapshot().canRead, true);
  complete(h, "project-b");
  assert.equal(source.getSnapshot().noticeId, 1);
  assert.equal(source.getSnapshot().phase, "completed");
  source.dispose();
});

test("source disposal releases every subscription and later events stay silent", () => {
  const h = harness();
  const source = createSource(h.ctx);
  let calls = 0;
  source.subscribe(() => calls++);
  begin(h);
  assert.ok(h.listenerCount() > 0);
  const before = calls;
  source.dispose();
  source.dispose();
  assert.equal(h.listenerCount(), 0);
  complete(h);
  assert.equal(calls, before);
});
