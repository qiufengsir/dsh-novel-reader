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
