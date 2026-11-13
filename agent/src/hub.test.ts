import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionHub, type HubChange } from "./hub.ts";
import { parseClientMessage } from "./protocol-guard.ts";
import type { HookEvent } from "./state.ts";
import { Store } from "./store.ts";
import { parseStatusline } from "./usage.ts";

const A = "0603472f-b7c5-4dae-b7a1-142468264b30";
const B = "34446bd8-9f71-4831-9f0b-d6094803dee2";
const ev = (session_id: string, hook_event_name: string, extra: Record<string, unknown> = {}): HookEvent => ({
  session_id,
  hook_event_name,
  cwd: "/Users/dev/claude-panel",
  ...extra,
});

function setup(store = new Store(), start = 1_000_000) {
  let now = start;
  const hub = new SessionHub(store, () => now);
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
});

describe("SessionHub statusline readings", () => {
  const reading = (id: string, extra: Record<string, unknown> = {}, now = 1_000_000) =>
    parseStatusline(
      JSON.stringify({
        session_id: id,
        cost: { total_cost_usd: 0.5 },
        context_window: { total_input_tokens: 1000, total_output_tokens: 20, used_percentage: 7 },
        rate_limits: { five_hour: { used_percentage: 40, resets_at: 2000 }, seven_day: { used_percentage: 30, resets_at: 9000 } },
        ...extra,
      }),
      now,
    )!;

  test("usage reaches the session, and an identical reading is not announced again", () => {
    const { hub, changes } = setup();
    hub.handleHook(ev(A, "Stop"));
    changes.length = 0;

    hub.handleStatusline(reading(A));
    hub.handleStatusline(reading(A));
    expect(hub.get(A)!.usage).toEqual({ costUsd: 0.5, contextPct: 7, inputTokens: 1000, outputTokens: 20 });
    expect(changes.filter((c) => c.type === "session")).toHaveLength(1);

    hub.handleStatusline(reading(A, { cost: { total_cost_usd: 0.6 } }));
    expect(hub.get(A)!.usage!.costUsd).toBe(0.6);
  });

  test("a session without a reading has no usage key at all", () => {
    const { hub } = setup();
    hub.handleHook(ev(A, "Stop"));
    expect("usage" in hub.get(A)!).toBe(false);
  });

  test("a reading that arrives before the session is kept for when its first hook does", () => {
    const { hub, changes } = setup();
    hub.handleStatusline(reading(B));
    expect(changes.filter((c) => c.type === "session")).toHaveLength(0);
    hub.handleHook(ev(B, "UserPromptSubmit"));
    expect(hub.get(B)!.usage!.costUsd).toBe(0.5);
  });

  test("today's spend adds up what each session cost since its last reading", () => {
    const { hub, changes } = setup();
    const cost = (id: string, usd: number) => hub.handleStatusline(reading(id, { cost: { total_cost_usd: usd } }));
    expect(hub.currentSpend()).toBeNull();

    cost(A, 0.5);
    cost(A, 0.5);
    cost(A, 0.75);
    cost(B, 1);
    expect(hub.currentSpend()!.usd).toBeCloseTo(1.75);
    const spends = changes.flatMap((c) => (c.type === "spend" ? [c.spend.usd] : []));
    expect(spends).toHaveLength(3);

    // A session that starts over (cost drops) counts whole again.
    cost(A, 0.25);
    expect(hub.currentSpend()!.usd).toBeCloseTo(2);
  });

  test("the last known limits survive a restart, until they reset", () => {
    const path = `${tmpdir()}/tomari-limits-${Date.now()}.db`;
    try {
      const first = setup(new Store(path));
      first.hub.handleStatusline(reading(A));
      first.store.close();

      const second = setup(new Store(path));
      expect(second.hub.currentLimits()!.fiveHour!.usedPct).toBe(40);
      second.tick(10_000_000);
      // Past its reset time the window stays; the overlay shows it as 0 %.
      expect(second.hub.currentLimits()!.fiveHour!.resetsAt).toBe(2_000_000);
      second.store.close();
    } finally {
      for (const ext of ["", "-wal", "-shm"]) rmSync(path + ext, { force: true });
    }
  });

  test("spend survives a restart of the agent without counting a session twice", () => {
    const path = `${tmpdir()}/tomari-spend-${Date.now()}.db`;
    try {
      const first = setup(new Store(path));
      first.hub.handleStatusline(reading(A, { cost: { total_cost_usd: 2 } }));
      first.store.close();

      const second = setup(new Store(path));
      expect(second.hub.currentSpend()!.usd).toBe(2);
      second.hub.handleStatusline(reading(A, { cost: { total_cost_usd: 2.5 } }));
      expect(second.hub.currentSpend()!.usd).toBeCloseTo(2.5);
      second.store.close();
    } finally {
      for (const ext of ["", "-wal", "-shm"]) rmSync(path + ext, { force: true });
    }
  });

  test("limits are announced once per change and shared by every session", () => {
    const { hub, changes } = setup();
    hub.handleStatusline(reading(A));
    hub.handleStatusline(reading(B));
    expect(changes.filter((c) => c.type === "limits")).toHaveLength(1);

    hub.handleStatusline(reading(A, { rate_limits: { five_hour: { used_percentage: 41, resets_at: 2000 }, seven_day: { used_percentage: 30, resets_at: 9000 } } }));
    expect(changes.filter((c) => c.type === "limits")).toHaveLength(2);
    expect(hub.currentLimits()).toMatchObject({ fiveHour: { usedPct: 41 }, sevenDay: { usedPct: 30 } });
  });

  test("a reading without rate_limits leaves the known limits alone", () => {
    const { hub } = setup();
    hub.handleStatusline(reading(A));
    hub.handleStatusline(reading(B, { rate_limits: undefined }));
    expect(hub.currentLimits()).toMatchObject({ fiveHour: { usedPct: 40 } });
  });

  test("windows that have reset are still reported, for the overlay to show as 0 %", () => {
    const { hub, tick } = setup(undefined, 1_000_000);
    hub.handleStatusline(reading(A, { rate_limits: { five_hour: { used_percentage: 40, resets_at: 1_001 }, seven_day: { used_percentage: 30, resets_at: 1_005 } } }));
    expect(hub.currentLimits()).not.toBeNull();
    tick(2_000_000); // now = 3_000_000 ms, past both resets (1_001_000 and 1_005_000 ms)
    expect(hub.currentLimits()).toMatchObject({ fiveHour: { resetsAt: 1_001_000 }, sevenDay: { resetsAt: 1_005_000 } });
  });
});
