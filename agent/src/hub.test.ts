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

function setup(store = new Store(), start = 1_000_000, sameNames = true) {
  let now = start;
  const hub = new SessionHub(store, () => now, sameNames);
  const changes: HubChange[] = [];
  hub.subscribe((c) => changes.push(c));
  return { hub, store, changes, tick: (ms: number) => (now += ms) };
}

describe("SessionHub", () => {
  test("a hook event creates a session named after its folder until the poll names it", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "UserPromptSubmit"));
    expect(hub.get(A)).toMatchObject({ name: "claude-panel", state: "working", live: true, pinned: false });

    hub.handleAgents([{ sessionId: A, name: "Claude panel", cwd: "/Users/dev/claude-panel", status: "busy", startedAt: 0 }]);
    expect(hub.get(A)!.name).toBe("Claude panel");
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

  describe("pins follow the session's name", () => {
    const composer = (sessionId: string, pid: number) => ({ sessionId, name: "composer", cwd: "/Users/dev/work", pid, status: "idle" as const, startedAt: 0 });

    test("reopening a named session under a new id keeps its pin, character and color, and drops the old record", () => {
      const { hub, changes, tick } = setup();
      hub.handleAgents([composer(A, 100)]);
      hub.setIcon(A, { character: "crab", color: "#ff6a1a" });

      // The terminal closes, then `claude -n composer` starts again with a new session id.
      tick(20_000);
      hub.handleAgents([composer(B, 200)]);

      expect(hub.has(A)).toBe(false);
      expect(changes).toContainEqual({ type: "removed", id: A });
      expect(hub.get(B)).toMatchObject({ name: "composer", live: true, pinned: true, position: 0, icon: { character: "crab", color: "#ff6a1a" } });
      expect(hub.snapshot().filter((s) => s.pinned)).toHaveLength(1);
    });

    test("unpinning one session of a name unpins the name", () => {
      const { hub, tick } = setup();
      hub.handleAgents([composer(A, 100)]);
      hub.setPinned(A, true);
      tick(20_000);
      hub.handleAgents([composer(B, 200)]);
      hub.setPinned(B, false);
      tick(20_000);
      hub.handleAgents([composer(A, 300)]);
      expect(hub.get(A)!.pinned).toBe(false);
    });

    test("a session pinned before the poll named it keeps the pin under its name", () => {
      const { hub, tick } = setup();
      hub.handleHook(ev(A, "Stop"));
      hub.setIcon(A, { character: "ghost", color: "#00ff00" });
      hub.handleAgents([composer(A, 100)]);

      tick(20_000);
      hub.handleAgents([composer(B, 200)]);
      expect(hub.get(B)).toMatchObject({ pinned: true, icon: { character: "ghost" } });
    });

    test("sessions without a name are pinned by id", () => {
      const { hub } = setup();
      hub.handleHook(ev(A, "Stop"));
      hub.handleHook(ev(B, "Stop"));
      hub.setPinned(A, true);
      expect(hub.get(A)!.pinned).toBe(true);
      expect(hub.get(B)!.pinned).toBe(false);
    });
  });

  test("the Claude process of running sessions only", () => {
    const { hub } = setup();
    hub.handleAgents([
      { sessionId: A, name: "composer", cwd: "/x", pid: 100, status: "idle", startedAt: 0 },
      { sessionId: B, name: "api-dev", cwd: "/x", status: "idle", startedAt: 0 },
    ]);
    expect(hub.processes()).toEqual([{ id: A, pid: 100 }]);
    expect(hub.pidOf(A)).toBe(100);
    expect(hub.pidOf(B)).toBeNull();

    hub.handleHook(ev(A, "SessionEnd"));
    expect(hub.pidOf(A)).toBeNull();
    expect(hub.processes()).toEqual([]);
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
});

describe("SessionHub in the Claude app, where a session keeps its id", () => {
  const titled = (sessionId: string, name: string) => ({ sessionId, name, cwd: "/Users/dev/app", pid: 1, status: "idle" as const, startedAt: 0 });
  const app = (store = new Store()) => setup(store, 1_000_000, false);

  test("adopting starts tracking a session that isn't running; a known one is left alone", () => {
    const { hub, changes } = app();
    hub.adopt(A, "Idle work", "/Users/dev/idle", 5000);
    expect(hub.get(A)).toMatchObject({ name: "Idle work", cwd: "/Users/dev/idle", state: "ended", live: false, stateSince: 5000 });
    expect(changes).toHaveLength(1);

    hub.adopt(A, "Other title", "/elsewhere", 9000);
    expect(hub.get(A)!.name).toBe("Idle work");
    expect(changes).toHaveLength(1);
  });

  test("two closed sessions with the same title both stay, also after a restart", () => {
    const { hub, store } = app();
    hub.adopt(A, "Fix the build", "/Users/dev/one", 5000);
    hub.adopt(B, "Fix the build", "/Users/dev/two", 6000);
    expect(hub.snapshot().map((s) => s.id).sort()).toEqual([A, B].sort());
    expect(app(store).hub.snapshot()).toHaveLength(2);
  });

  test("a pinned session keeps its pin and icon when the app retitles it", () => {
    const { hub } = app();
    hub.adopt(A, "Idle work", "/Users/dev/idle", 5000);
    hub.setIcon(A, { character: "owl", color: "#4f7cff" });
    hub.handleAgents([titled(A, "Migrate the database")]);
    expect(hub.get(A)).toMatchObject({ name: "Migrate the database", live: true, pinned: true, icon: { character: "owl", color: "#4f7cff" } });
  });

  test("switching to a host that reopens sessions under new ids merges the same names", () => {
    const { hub, changes } = app();
    hub.adopt(A, "composer", "/Users/dev/work", 5000);
    hub.adopt(B, "composer", "/Users/dev/work", 6000);
    hub.replaceSameNames(true);
    expect(hub.snapshot().map((s) => s.id)).toEqual([B]);
    expect(changes.at(-1)).toEqual({ type: "removed", id: A });
  });
});

describe("parseClientMessage", () => {
  test("accepts the whitelisted commands", () => {
    expect(parseClientMessage(JSON.stringify({ type: "library" }))).toEqual({ type: "library" });
    expect(parseClientMessage(JSON.stringify({ type: "open", id: A }))).toEqual({ type: "open", id: A });
    expect(parseClientMessage(JSON.stringify({ type: "pin", id: A, pinned: true }))).toEqual({ type: "pin", id: A, pinned: true });
    expect(parseClientMessage(JSON.stringify({ type: "icon", id: A, icon: { character: "crab", color: "#FF6A1A" } }))).toEqual({
      type: "icon",
      id: A,
      icon: { character: "crab", color: "#ff6a1a" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "host", host: "ghostty" }))).toEqual({ type: "host", host: "ghostty" });
    expect(parseClientMessage(JSON.stringify({ type: "host", host: "desktop" }))).toEqual({ type: "host", host: "desktop" });
  });

  test("rejects everything else", () => {
    const bad = [
      "not json",
      "null",
      JSON.stringify({ type: "open", id: "; rm -rf /" }),
      JSON.stringify({ type: "exec", id: A, command: "ls" }),
      JSON.stringify({ type: "pin", id: A, pinned: "yes" }),
      JSON.stringify({ type: "icon", id: A, icon: { character: "../etc", color: "#fff" } }),
      JSON.stringify({ type: "host", host: "iterm" }),
      JSON.stringify({ type: "host" }),
    ];
    for (const raw of bad) expect(parseClientMessage(raw)).toBeNull();
  });
});
