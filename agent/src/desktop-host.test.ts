import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { desktopHost } from "./desktop-host.ts";
import { planOpen, runOnTerminal } from "./open-session.ts";
import type { DesktopSession } from "./desktop-sessions.ts";
import { SessionHub } from "./hub.ts";
import type { AgentEntry } from "./state.ts";
import { Store } from "./store.ts";

const ID = "0603472f-b7c5-4dae-b7a1-142468264b30";
const IDLE = "22222222-2222-4222-8222-222222222222";
const ELSEWHERE = "55555555-5555-4555-8555-555555555555";
const DESKTOP: DesktopSession[] = [
  { localId: "local_idle", sessionId: IDLE, title: "Idle work", cwd: "/Users/dev/idle", lastActivityAt: 5000, archived: false },
  { localId: "local_old", sessionId: "33333333-3333-4333-8333-333333333333", title: "Old", cwd: "/x", lastActivityAt: 1, archived: true },
];

function setup({ openFails = false } = {}) {
  const hub = new SessionHub(new Store(), Date.now, false);
  const opened: string[] = [];
  const live: AgentEntry[] = [{ sessionId: ELSEWHERE, name: "notes", cwd: "/Users/dev/notes", status: "idle", startedAt: 0 }];
  let report: (id: string | null) => void = () => {};
  const watching: string[] = [];
  const host = desktopHost(hub, {
    list: async () => live,
    desktopSessions: async () => DESKTOP,
    open: async (id) => {
      opened.push(id);
      return openFails ? { ok: false, error: "running outside the desktop app (cli, pid 7): open it in its terminal" } : { ok: true, command: ["fake-open", id] };
    },
    watch: (onFocus) => {
      report = onFocus;
      watching.push("started");
      return () => watching.push("stopped");
    },
  });
  return { hub, host, opened, live, watching, report: (id: string | null) => report(id) };
}

test("it is the desktop host, where a session keeps its id", () => {
  const { host } = setup();
  expect(host.id).toBe("desktop");
  expect(host.reopensUnderNewId).toBe(false);
});

test("tracks every running session, whatever its folder", async () => {
  const { host, live } = setup();
  expect(await host.sessions()).toEqual(live);
});

test("opening goes through the app by session id; a refusal is passed on", async () => {
  const ok = setup();
  expect(await ok.host.open(IDLE)).toEqual({ focused: true });
  expect(ok.opened).toEqual([IDLE]);

  const refused = setup({ openFails: true });
  expect(await refused.host.open(IDLE)).toEqual({ focused: false, message: "running outside the desktop app (cli, pid 7): open it in its terminal" });
});

test("the library lists the app's sessions that aren't archived, running or not", async () => {
  const { host } = setup();
  expect(await host.library()).toEqual([{ id: IDLE, name: "Idle work", cwd: "/Users/dev/idle", lastActivityAt: 5000, pinned: false }]);
});

test("adopting a session that isn't running lets it be pinned, under its title", async () => {
  const { hub, host } = setup();
  expect(hub.has(IDLE)).toBe(false);
  await host.adopt(IDLE);
  expect(hub.get(IDLE)).toMatchObject({ id: IDLE, name: "Idle work", live: false, state: "ended" });
  expect(hub.setPinned(IDLE, true)).toBe(true);
  expect((await host.library())[0]!.pinned).toBe(true);

  await host.adopt(ELSEWHERE); // not one of the app's sessions
  expect(hub.has(ELSEWHERE)).toBe(false);
});

test("following focus sets the hub's focused session from the app's log watcher", () => {
  const { hub, host, watching, report } = setup();
  const stop = host.followFocus();
  report(IDLE);
  expect(hub.focusedId).toBe(IDLE);
  report(null);
  expect(hub.focusedId).toBeNull();
  stop();
  expect(watching).toEqual(["started", "stopped"]);
});

test("planOpen: deep link for desktop sessions (running or not), refuse terminal ones, --resume otherwise", async () => {
  const root = mkdtempSync(`${tmpdir()}/claude-open-`);
  const liveDir = `${root}/live`;
  const desktopDir = `${root}/desktop`;
  mkdirSync(liveDir);
  mkdirSync(`${desktopDir}/account/org`, { recursive: true });
  const dirs = { liveDir, desktopDir };
  try {
    expect(await planOpen("not-a-uuid", dirs)).toEqual({ ok: false, error: "invalid session id" });

    const unknown = await planOpen(ID, dirs);
    expect(unknown.ok && unknown.command.slice(1)).toEqual(["--desktop", "--resume", ID]);

    // process.pid makes the fake session count as running.
    writeFileSync(`${liveDir}/1.json`, JSON.stringify({ pid: process.pid, sessionId: ID, entrypoint: "cli" }));
    expect(await planOpen(ID, dirs)).toMatchObject({ ok: false, inTerminal: true });

    // Known to the desktop app: its link wins, whether or not a process runs.
    writeFileSync(`${desktopDir}/account/org/local_abc-123.json`, JSON.stringify({ sessionId: "local_abc-123", cliSessionId: ID }));
    expect(await planOpen(ID, dirs)).toEqual({ ok: true, command: ["open", "claude://code/continue?session=local_abc-123"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commands run on a terminal, because `claude --desktop` refuses redirected output", async () => {
  expect(await runOnTerminal(["sh", "-c", "test -t 1 && echo on-a-tty"])).toEqual({ code: 0, output: "on-a-tty" });
  expect(await runOnTerminal(["sh", "-c", "printf '\\033[31mNo session found\\033[0m\\n'; exit 1"])).toEqual({ code: 1, output: "No session found" });
  expect(await runOnTerminal(["sh", "-c", "pwd"], "/usr/bin")).toEqual({ code: 0, output: "/usr/bin" });
  expect((await runOnTerminal(["sh", "-c", "pwd"], "/nonexistent/folder")).code).toBe(0);
});

test("a closed session the app doesn't know is resumed from its own folder", async () => {
  const hub = new SessionHub(new Store(), Date.now, false);
  hub.adopt(ID, "Old work", "/Users/dev/old", 5000);
  const calls: [string, string | undefined][] = [];
  const host = desktopHost(hub, { open: async (id, cwd) => (calls.push([id, cwd]), { ok: true, command: [] }), watch: () => () => {} });
  await host.open(ID);
  expect(calls).toEqual([[ID, "/Users/dev/old"]]);
});

test("a session still running in a terminal is brought to the front there, not resumed in the app", async () => {
  const refusal = { ok: false as const, error: "running outside the desktop app (cli, pid 7): open it in its terminal", inTerminal: true as const };
  const hub = new SessionHub(new Store(), Date.now, false);
  const asked: string[] = [];
  const host = desktopHost(hub, {
    open: async () => refusal,
    watch: () => () => {},
    inTerminal: async (id) => (asked.push(id), { focused: true }),
  });
  expect(await host.open(ID)).toEqual({ focused: true });
  expect(asked).toEqual([ID]);

  const noPanel = desktopHost(hub, { open: async () => refusal, watch: () => () => {}, inTerminal: async () => ({ focused: false, message: "no Ghostty panel found; showed Ghostty" }) });
  expect(await noPanel.open(ID)).toEqual({ focused: false, message: "no Ghostty panel found; showed Ghostty" });

  const otherFailure = desktopHost(hub, { open: async () => ({ ok: false, error: "claude exited with 1" }), watch: () => () => {}, inTerminal: async (id) => (asked.push(id), { focused: true }) });
  expect(await otherFailure.open(ID)).toEqual({ focused: false, message: "claude exited with 1" });
  expect(asked).toEqual([ID]);
});
