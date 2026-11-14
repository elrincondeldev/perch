import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionHub, type HubChange } from "./hub.ts";
import { parseClientMessage } from "./protocol-guard.ts";
import type { HookEvent } from "./state.ts";
import { Store } from "./store.ts";

const A = "0603472f-b7c5-4dae-b7a1-142468264b30";
const B = "34446bd8-9f71-4831-9f0b-d6094803dee2";
const ev = (session_id: string, hook_event_name: string, extra: Record<string, unknown> = {}): HookEvent => ({
  session_id,
  hook_event_name,
  cwd: "/Users/dev/claude-panel",
  ...extra,
});

function setup(store = new Store(), start = 1_000_000, readPrompt?: (id: string, transcriptPath?: string) => Promise<string | null>) {
  let now = start;
  const hub = new SessionHub(store, () => now, readPrompt);
  const changes: HubChange[] = [];
  hub.subscribe((c) => changes.push(c));
  return { hub, store, changes, tick: (ms: number) => (now += ms) };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await Bun.sleep(1);
  }
}

describe("SessionHub", () => {
  test("a hook event creates a session named after its folder until the poll names it", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit"));
    expect(hub.get(A)).toMatchObject({ name: "claude-panel", state: "working", live: true, pinned: false });

    hub.handleAgents([{ sessionId: A, name: "Claude panel", cwd: "/Users/dev/claude-panel", status: "busy", startedAt: 0 }]);
    expect(hub.get(A)!.name).toBe("Claude panel");
  });

  test("tabs in one folder get told apart by the start of their first prompt", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "SessionStart"));
    hub.handleHook(ev(B, "SessionStart"));
    expect(hub.get(A)!.name).not.toBe(hub.get(B)!.name); // no prompt yet: a short id tells them apart
    expect(hub.get(A)!.name).toBe(`claude-panel · ${A.slice(0, 4)}`);

    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "fix the login\n  redirect loop on Safari, please" }));
    hub.handleHook(ev(B, "UserPromptSubmit", { prompt: "add tests" }));
    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "a later prompt does not rename it" }));
    expect(hub.get(A)!.name).toBe("claude-panel · fix the login redirect…");
    expect(hub.get(B)!.name).toBe("claude-panel · add tests");
  });

  test("a missing snippet is read from the transcript, lazily, once, and announced when it arrives", async () => {
    const calls: [string, string | undefined][] = [];
    const reads: Promise<unknown>[] = [];
    const answers: Record<string, string | null> = { [A]: "fix the login redirect loop on Safari", [B]: null };
    const { hub, changes } = setup(new Store(), 1_000_000, (id, path) => {
      calls.push([id, path]);
      const read = Promise.resolve(answers[id] ?? null);
      reads.push(read);
      return read;
    });
    hub.handleHook(ev(A, "SessionStart", { transcript_path: "/Users/dev/.claude/projects/p/a.jsonl" }));
    expect(calls).toEqual([]); // no clash, nothing to read
    hub.handleHook(ev(B, "SessionStart"));
    expect(hub.get(A)!.name).toBe(`claude-panel · ${A.slice(0, 4)}`); // the short id until the read lands
    await waitFor(() => hub.get(A)!.name.endsWith("redirect…"));
    expect(hub.get(B)!.name).toBe(`claude-panel · ${B.slice(0, 4)}`); // not found: the fallback stays
    expect(changes.some((c) => c.type === "session" && c.session.id === A && c.session.name.endsWith("redirect…"))).toBe(true);
    hub.handleHook(ev(A, "Stop"));
    hub.handleHook(ev(B, "Stop"));
    await Promise.allSettled(reads); // every read has landed; the hub's own handlers ran before this continues
    expect(calls).toEqual([
      [A, "/Users/dev/.claude/projects/p/a.jsonl"],
      [B, undefined],
    ]); // each read once, "not found" included
  });

  test("a read that fails leaves the short id and does not break hook handling", async () => {
    const reads: Promise<unknown>[] = [];
    const { hub } = setup(new Store(), 1_000_000, () => {
      const read = Promise.reject(new Error("EACCES"));
      reads.push(read);
      return read;
    });
    hub.handleHook(ev(A, "SessionStart"));
    hub.handleHook(ev(B, "SessionStart"));
    await Promise.allSettled(reads);
    expect(hub.get(A)!.name).toBe(`claude-panel · ${A.slice(0, 4)}`);
  });

  test("a prompt seen by hooks wins over a late transcript read", async () => {
    const pending: ((v: string) => void)[] = [];
    const reads: Promise<unknown>[] = [];
    const { hub } = setup(new Store(), 1_000_000, () => {
      const read = new Promise<string>((r) => pending.push(r));
      reads.push(read);
      return read;
    });
    hub.handleHook(ev(A, "SessionStart"));
    hub.handleHook(ev(B, "SessionStart"));
    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "live prompt" }));
    for (const release of pending) release("transcript prompt");
    await Promise.allSettled(reads);
    expect(hub.get(A)!.name).toBe("claude-panel · live prompt");
    expect(hub.get(B)!.name).toBe("claude-panel · transcript prompt");
  });

  test("a lookup that ran with no transcript path is tried once more when a hook brings the path", async () => {
    const calls: [string, string | undefined][] = [];
    const reads: Promise<unknown>[] = [];
    const { hub } = setup(new Store(), 1_000_000, (id, path) => {
      calls.push([id, path]);
      const read = Promise.resolve(path && id === A ? "fix the login redirect loop" : null);
      reads.push(read);
      return read;
    });
    hub.handleHook(ev(A, "SessionStart"));
    hub.handleHook(ev(B, "SessionStart"));
    await Promise.allSettled(reads);
    expect(calls).toEqual([[A, undefined], [B, undefined]]);
    expect(hub.get(A)!.name).toBe(`claude-panel · ${A.slice(0, 4)}`);

    hub.handleHook(ev(A, "Stop", { transcript_path: "/Users/dev/.claude/projects/p/a.jsonl" }));
    await waitFor(() => hub.get(A)!.name.endsWith("redirect…"));
    hub.handleHook(ev(A, "Stop", { transcript_path: "/Users/dev/.claude/projects/p/a.jsonl" }));
    hub.handleHook(ev(B, "Stop", { transcript_path: "/Users/dev/.claude/projects/p/b.jsonl" }));
    await Promise.allSettled(reads);
    expect(calls).toEqual([
      [A, undefined],
      [B, undefined],
      [A, "/Users/dev/.claude/projects/p/a.jsonl"],
      [B, "/Users/dev/.claude/projects/p/b.jsonl"],
    ]); // one more try each, and no more after that
  });

  test("a lone session, or one with a title, keeps its plain label", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "hello" }));
    expect(hub.get(A)!.name).toBe("claude-panel");

    hub.handleHook(ev(B, "UserPromptSubmit", { prompt: "world" }));
    hub.handleAgents([{ sessionId: B, name: "Release work", cwd: "/Users/dev/claude-panel", status: "busy", startedAt: 0 }]);
    expect(hub.get(B)!.name).toBe("Release work");
    expect(hub.get(A)!.name).toBe("claude-panel");
  });

  test("a label change reaches the panel for the session that was already shown", () => {
    const { hub, changes } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "first" }));
    hub.handleHook(ev(B, "UserPromptSubmit", { prompt: "second" }));
    const renamed = changes.filter((c) => c.type === "session" && c.session.id === A).map((c) => c.type === "session" && c.session.name);
    expect(renamed).toEqual(["claude-panel", "claude-panel · first"]);
  });

  test("labels of ended sessions do not force a suffix on the live one", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "old" }));
    hub.handleHook(ev(A, "SessionEnd"));
    hub.handleHook(ev(B, "UserPromptSubmit", { prompt: "new" }));
    expect(hub.get(B)!.name).toBe("claude-panel");
  });

  test("the strip lists tabs in a stable order: by when they started", () => {
    const { hub, tick } = setup();
    hub.handleHook(ev(B, "UserPromptSubmit", { prompt: "second id, first tab" }));
    tick(1000);
    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "first id, second tab" }));
    tick(1000);
    hub.handleHook(ev(B, "Stop"));
    expect(hub.snapshot().map((s) => s.id)).toEqual([B, A]);
    expect(hub.liveEntries().map((s) => s.id)).toEqual([B, A]);
  });

  test("a live session whose process is gone ends, even if no hook or poll said so", () => {
    const { hub } = setup();
    hub.handleAgents([{ sessionId: A, cwd: "/x", pid: 111, status: "busy", startedAt: 0 }]);
    hub.handleHook(ev(B, "UserPromptSubmit")); // seen by hooks only: no pid yet
    hub.endDead((pid) => pid !== 111, new Map([[B, 222]]));
    expect(hub.get(A)).toMatchObject({ state: "ended", live: false });
    expect(hub.get(B)).toMatchObject({ state: "working", live: true });

    hub.endDead((pid) => pid !== 222, new Map([[B, 222]])); // the pid comes from ~/.claude/sessions
    expect(hub.get(B)).toMatchObject({ state: "ended", live: false });
  });

  test("a stale recorded pid doesn't end a session whose new process is alive", () => {
    const { hub } = setup();
    hub.handleAgents([{ sessionId: A, cwd: "/x", pid: 111, status: "busy", startedAt: 0 }]);
    hub.endDead((pid) => pid !== 111, new Map([[A, 333]])); // resumed: ~/.claude/sessions has the new pid
    expect(hub.get(A)).toMatchObject({ state: "working", live: true });
  });

  test("a session with no known pid is left alone", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit"));
    hub.endDead(() => false, new Map());
    expect(hub.get(A)!.live).toBe(true);
  });

  test("only visible changes are announced", () => {
    const { hub, changes } = setup();
    const tool = { tool_name: "Bash", tool_input: { command: "ls" } };
    hub.handleHook(ev(A, "PreToolUse", tool));
    hub.handleHook(ev(A, "PostToolUse", tool)); // same state, same activity
    hub.handleHook(ev(A, "Stop"));
    expect(changes.map((c) => c.type === "session" && c.session.state)).toEqual(["working", "done"]);
  });

  test("pins get consecutive positions; unpinning resets the icon", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "Stop"));
    hub.handleHook(ev(B, "Stop"));

    hub.setPinned(A, true);
    hub.setPinned(B, true);
    expect(hub.get(A)).toMatchObject({ pinned: true, position: 0 });
    expect(hub.get(B)).toMatchObject({ pinned: true, position: 1 });

    hub.setIcon(A, { character: "crab", color: "#ff6a1a" });
    hub.setPinned(A, false);
    expect(hub.get(A)).toMatchObject({ pinned: false, position: null, icon: { character: "default" } });
  });

  test("setting an icon pins the session if needed and keeps an existing position", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "Stop"));
    hub.handleHook(ev(B, "Stop"));
    hub.setPinned(A, true);

    expect(hub.setIcon(B, { character: "crab", color: "#ff6a1a" })).toBe(true);
    expect(hub.get(B)).toMatchObject({ pinned: true, position: 1, icon: { character: "crab", color: "#ff6a1a" } });

    hub.setIcon(A, { character: "ghost", color: "#00ff00" });
    expect(hub.get(A)).toMatchObject({ pinned: true, position: 0, icon: { character: "ghost" } });
  });

  test("adopting a session that isn't running tracks it as closed, and the poll revives it", () => {
    const { hub } = setup();
    hub.adopt(A, "Idle work", "/Users/dev/idle", 5000);
    hub.adopt(A, "ignored", "/ignored", 0);
    expect(hub.get(A)).toMatchObject({ name: "Idle work", live: false, state: "ended", stateSince: 5000 });

    hub.handleAgents([{ sessionId: A, name: "Idle work", cwd: "/Users/dev/idle", status: "idle", startedAt: 0 }]);
    expect(hub.get(A)).toMatchObject({ live: true, state: "idle" });
  });

  test("focus is announced once per change", () => {
    const { hub, changes } = setup();
    hub.setFocused(A);
    hub.setFocused(A);
    hub.setFocused(null);
    expect(changes).toEqual([
      { type: "focus", id: A },
      { type: "focus", id: null },
    ]);
  });

  test("unknown sessions cannot be pinned or given an icon", () => {
    const { hub } = setup();
    expect(hub.setPinned(A, true)).toBe(false);
    expect(hub.setIcon(A, { character: "crab", color: "#ff6a1a" })).toBe(false);
  });

  describe("with a database file", () => {
    const path = `${tmpdir()}/claude-panel-test-${process.pid}.db`;
    afterEach(() => {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    });

    test("sessions and pins survive a restart", () => {
      const first = setup(new Store(path));
      first.hub.handleHook(ev(A, "Stop"));
      first.hub.setPinned(A, true);
      first.hub.setIcon(A, { character: "ghost", color: "#00ff00" });
      first.store.close();

      const second = setup(new Store(path));
      expect(second.hub.get(A)).toMatchObject({ state: "done", pinned: true, icon: { character: "ghost" } });
      second.store.close();
    });
  });

  test("prune forgets old ended sessions unless pinned", () => {
    const { hub, changes, tick } = setup();
    hub.handleHook(ev(A, "SessionEnd", { reason: "other" }));
    hub.handleHook(ev(B, "SessionEnd", { reason: "other" }));
    hub.setPinned(B, true);
    tick(25 * 60 * 60 * 1000);

    hub.prune();
    expect(hub.has(A)).toBe(false);
    expect(hub.has(B)).toBe(true);
    expect(changes.at(-1)).toEqual({ type: "removed", id: A });
  });

  test("liveEntries lists the running sessions for the + library", () => {
    const { hub, tick } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit"));
    hub.setPinned(A, true);
    tick(5000);
    hub.handleAgents([{ sessionId: B, name: "Polled", cwd: "/Users/dev/polled", status: "idle", startedAt: 0 }]);
    hub.adopt("c0ffee00-0000-4000-8000-000000000000", "Closed", "/Users/dev/closed", 1); // not running

    expect(hub.liveEntries()).toEqual([
      // A hook-known session was last active at its last event; a polled one, when its state began.
      { id: A, name: "claude-panel", cwd: "/Users/dev/claude-panel", lastActivityAt: 1_000_000, pinned: true },
      { id: B, name: "Polled", cwd: "/Users/dev/polled", lastActivityAt: 1_005_000, pinned: false },
    ]);
  });

  test("liveEntries leaves out background sessions, which can't be opened in a terminal", () => {
    const { hub } = setup();
    const C = "c0ffee00-0000-4000-8000-000000000000";
    hub.handleHook(ev(A, "UserPromptSubmit")); // hooks only: kind unknown
    hub.handleAgents([
      { sessionId: B, cwd: "/Users/dev/term", kind: "interactive", status: "idle", startedAt: 0 },
      { sessionId: C, cwd: "/Users/dev/bg", kind: "background", status: "idle", startedAt: 0 },
    ]);
    expect(hub.liveEntries().map((e) => e.id)).toEqual([A, B]);
  });
});

describe("background sessions", () => {
  test("the panel session carries the kind the poll reported", () => {
    const { hub, changes } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit"));
    expect(hub.get(A)!.kind).toBeUndefined();
    changes.length = 0;
    hub.handleAgents([{ sessionId: A, cwd: "/Users/dev/bg", kind: "background", status: "busy", startedAt: 0 }]);
    expect(hub.get(A)!.kind).toBe("background");
    expect(changes).toMatchObject([{ type: "session", session: { id: A, kind: "background" } }]);
  });

  test("endSession ends the record at once and tells the panel", () => {
    const { hub, changes } = setup();
    hub.handleAgents([{ sessionId: A, cwd: "/Users/dev/bg", kind: "background", status: "busy", startedAt: 0 }]);
    changes.length = 0;
    expect(hub.endSession(A)).toBe(true);
    expect(hub.get(A)).toMatchObject({ state: "ended", live: false, activity: null });
    expect(changes).toMatchObject([{ type: "session", session: { id: A, state: "ended", live: false } }]);
    expect(hub.endSession("c0ffee00-0000-4000-8000-000000000000")).toBe(false);
  });

  test("a stopped session stays ended while the poll still lists its process, for a while", () => {
    const { hub, tick } = setup();
    const entry = { sessionId: A, cwd: "/Users/dev/bg", kind: "background", status: "busy" as const, startedAt: 0 };
    hub.handleAgents([entry]);
    hub.endSession(A);
    tick(5_000);
    hub.handleAgents([entry]);
    expect(hub.get(A)).toMatchObject({ state: "ended", live: false });
    tick(30_000); // the process should be gone by now: a listing means it really runs again
    hub.handleAgents([entry]);
    expect(hub.get(A)).toMatchObject({ live: true });
  });

  test("stopping the focused session clears the focus", () => {
    const { hub, changes } = setup();
    hub.handleAgents([{ sessionId: A, cwd: "/Users/dev/bg", kind: "background", status: "busy", startedAt: 0 }]);
    hub.handleAgents([{ sessionId: B, cwd: "/Users/dev/other", kind: "background", status: "busy", startedAt: 0 }]);
    hub.setFocused(A);
    changes.length = 0;
    hub.endSession(B);
    expect(hub.focusedId).toBe(A); // another session's stop leaves it alone
    hub.endSession(A);
    expect(hub.focusedId).toBeNull();
    expect(changes).toContainEqual({ type: "focus", id: null });
  });

  test("titleOf gives the real title, never the display label", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit", { prompt: "first" }));
    hub.handleHook(ev(B, "UserPromptSubmit", { prompt: "second" }));
    expect(hub.get(A)!.name).toBe("claude-panel · first"); // a label made of folder and prompt
    expect(hub.titleOf(A)).toBeNull();
    hub.handleAgents([{ sessionId: B, name: "Release work", cwd: "/Users/dev/claude-panel", status: "busy", startedAt: 0 }]);
    expect(hub.titleOf(B)).toBe("Release work");
    expect(hub.titleOf("c0ffee00-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("parseClientMessage", () => {
  test("accepts the whitelisted commands", () => {
    expect(parseClientMessage(JSON.stringify({ type: "library" }))).toEqual({ type: "library" });
    expect(parseClientMessage(JSON.stringify({ type: "open", id: A }))).toEqual({ type: "open", id: A });
    expect(parseClientMessage(JSON.stringify({ type: "stop", id: A, extra: "x" }))).toEqual({ type: "stop", id: A });
    expect(parseClientMessage(JSON.stringify({ type: "stop", id: "--all" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "stop" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "pin", id: A, pinned: true }))).toEqual({ type: "pin", id: A, pinned: true });
    expect(parseClientMessage(JSON.stringify({ type: "icon", id: A, icon: { character: "crab", color: "#FF6A1A" } }))).toEqual({
      type: "icon",
      id: A,
      icon: { character: "crab", color: "#ff6a1a" },
    });
  });

  test("terminal takes no arguments: anything else sent with it is dropped", () => {
    expect(parseClientMessage(JSON.stringify({ type: "terminal" }))).toEqual({ type: "terminal" });
    expect(parseClientMessage(JSON.stringify({ type: "terminal", command: "rm -rf ~", id: A }))).toEqual({ type: "terminal" });
  });

  test("frontApp accepts only the known app kinds and is rebuilt from the validated field", () => {
    for (const app of ["terminal", "desktop", "other"] as const) {
      expect(parseClientMessage(JSON.stringify({ type: "frontApp", app, id: A, extra: "x" }))).toEqual({ type: "frontApp", app });
    }
    for (const app of ["Terminal", "safari", "", 1, null, undefined]) {
      expect(parseClientMessage(JSON.stringify({ type: "frontApp", app }))).toBeNull();
    }
  });

  test("rejects everything else", () => {
    const bad = [
      "not json",
      "null",
      JSON.stringify({ type: "open", id: "; rm -rf /" }),
      JSON.stringify({ type: "exec", id: A, command: "ls" }),
      JSON.stringify({ type: "pin", id: A, pinned: "yes" }),
      JSON.stringify({ type: "icon", id: A, icon: { character: "../etc", color: "#fff" } }),
    ];
    for (const raw of bad) expect(parseClientMessage(raw)).toBeNull();
  });

  test("tabbed background sessions are marked inTab, and only a change is announced", () => {
    const { hub, changes } = setup();
    hub.handleAgents([
      { sessionId: A, name: "bg", cwd: "/x", status: "idle", startedAt: 0, kind: "background" },
      { sessionId: B, name: "term", cwd: "/x", status: "idle", startedAt: 0, kind: "interactive" },
    ]);
    expect(hub.get(A)?.inTab).toBe(false);
    expect(hub.get(B)?.inTab).toBeUndefined();
    changes.length = 0;
    hub.setTabbed(new Set([A]));
    expect(changes).toEqual([{ type: "session", session: expect.objectContaining({ id: A, inTab: true }) }]);
    hub.setTabbed(new Set([A])); // same set: silent
    expect(changes.length).toBe(1);
    hub.setTabbed(new Set([A, B])); // B is not a background session: nothing to announce
    expect(changes.length).toBe(1);
    expect(hub.get(B)?.inTab).toBeUndefined();
    hub.setTabbed(new Set());
    expect(changes.length).toBe(2);
    expect(hub.get(A)?.inTab).toBe(false);
  });
});
