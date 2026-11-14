import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { openTerminalTab, planOpen, run, sessionPids, type OpenResult } from "./open-session.ts";

const ID = "0603472f-b7c5-4dae-b7a1-142468264b30";
const CLOSED = "22222222-2222-4222-8222-222222222222"; // not running
const REFUSED: OpenResult = { ok: false, error: `running outside the desktop app (cli, pid ${process.pid}): open it in its terminal` };

let root: string;
let liveDir: string;
let desktopDir: string;

beforeEach(() => {
  root = mkdtempSync(`${tmpdir()}/open-session-`);
  liveDir = `${root}/live`;
  desktopDir = `${root}/desktop`; // left missing, as on a Mac without the desktop app
  mkdirSync(liveDir);
  // process.pid makes the fake session count as running.
  writeFileSync(`${liveDir}/1.json`, JSON.stringify({ pid: process.pid, sessionId: ID, entrypoint: "cli" }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a live terminal session focuses the Terminal.app tab on its tty", async () => {
  const asked: number[] = [];
  const ttyOf = async (pid: number) => {
    asked.push(pid);
    return "ttys003";
  };
  const plan = await planOpen(ID, { liveDir, desktopDir, ttyOf });
  expect(asked).toEqual([process.pid]);
  if (!plan.ok) throw new Error(plan.error);
  const [bin, flag, script, tty] = plan.command;
  expect([bin, flag, tty]).toEqual(["osascript", "-e", "/dev/ttys003"]);
  expect(plan.command).toHaveLength(4);
  // The tty reaches the script as argv, never inside its source.
  expect(script).toContain("on run argv");
  expect(script).not.toContain("ttys003");
});

test("a live session without a valid tty is still refused", async () => {
  for (const tty of [undefined, "", "??", "console", "ttys", "ttys003\n", "ttys003; rm -rf ~", "../ttys003"]) {
    expect(await planOpen(ID, { liveDir, desktopDir, ttyOf: async () => tty })).toEqual(REFUSED);
  }
});

test("the desktop app's link still wins over the terminal tab", async () => {
  mkdirSync(`${desktopDir}/account/org`, { recursive: true });
  writeFileSync(`${desktopDir}/account/org/local_abc-123.json`, JSON.stringify({ sessionId: "local_abc-123", cliSessionId: ID }));
  expect(await planOpen(ID, { liveDir, desktopDir, ttyOf: async () => "ttys003" })).toEqual({
    ok: true,
    command: ["open", "claude://code/continue?session=local_abc-123"],
  });
});

test("without the desktop app, a closed session resumes in a new Terminal tab, in its folder", async () => {
  const plan = await planOpen(CLOSED, { liveDir, desktopDir, cwd: "/Users/dev/my project" });
  if (!plan.ok) throw new Error(plan.error);
  const [bin, flag, script, ...argv] = plan.command;
  expect([bin, flag]).toEqual(["osascript", "-e"]);
  expect(argv).toEqual(["/Users/dev/my project", CLOSED]);
  expect(script).toContain("quoted form of");
  expect(script).not.toContain(CLOSED);
});

test("without a known folder it resumes in the home folder", async () => {
  const plan = await planOpen(CLOSED, { liveDir, desktopDir });
  expect(plan.ok && plan.command.slice(3)).toEqual([homedir(), CLOSED]);
});

test("with no folder from the hub, a closed session resumes where the CLI last recorded it", async () => {
  writeFileSync(`${liveDir}/2.json`, JSON.stringify({ pid: 2_000_000_000, sessionId: CLOSED, cwd: "/Users/dev/recorded" }));
  for (const cwd of [undefined, ""]) {
    const plan = await planOpen(CLOSED, { liveDir, desktopDir, cwd });
    expect(plan.ok && plan.command.slice(3)).toEqual(["/Users/dev/recorded", CLOSED]);
  }
  // The hub's folder, when it has one, still wins.
  const plan = await planOpen(CLOSED, { liveDir, desktopDir, cwd: "/Users/dev/hub" });
  expect(plan.ok && plan.command.slice(3)).toEqual(["/Users/dev/hub", CLOSED]);
});

test("an odd folder name reaches the script only as argv", async () => {
  const cwd = `/tmp/it's "odd" $(touch pwned); rm -rf ~`;
  const plan = await planOpen(CLOSED, { liveDir, desktopDir, cwd });
  if (!plan.ok) throw new Error(plan.error);
  expect(plan.command.at(-2)).toBe(cwd);
  for (const part of ["it's", "odd", "pwned", "rm -rf"]) expect(plan.command[2]).not.toContain(part);
});

test("with the desktop app installed, a closed session it doesn't know resumes in Terminal, where it was born", async () => {
  mkdirSync(desktopDir);
  const plan = await planOpen(CLOSED, { liveDir, desktopDir, cwd: "/Users/dev/project" });
  if (!plan.ok) throw new Error(plan.error);
  expect(plan.command[0]).toBe("osascript");
  expect(plan.command.slice(-2)).toEqual(["/Users/dev/project", CLOSED]);
});

test("a resumed session maps to its running pid, not the dead one left behind", async () => {
  writeFileSync(`${liveDir}/0.json`, JSON.stringify({ pid: 2_000_000_000, sessionId: ID }));
  expect((await sessionPids(liveDir)).get(ID)).toBe(process.pid);
});

test("a live background session attaches in a new Terminal tab instead of focusing a tty", async () => {
  const ttyOf = async () => {
    throw new Error("must not look for a tty");
  };
  const plan = await planOpen(ID, { liveDir, desktopDir, ttyOf, kind: "background" });
  if (!plan.ok) throw new Error(plan.error);
  const [bin, flag, script, ...argv] = plan.command;
  expect([bin, flag]).toEqual(["osascript", "-e"]);
  expect(argv).toEqual([ID.slice(0, 8)]); // `claude agents` lists background sessions by their short id
  expect(script).toContain("claude attach");
  expect(script).toContain("quoted form of");
  expect(script).not.toContain(ID.slice(0, 8));
});

test("a closed background session still resumes, and an interactive one still focuses its tab", async () => {
  const closed = await planOpen(CLOSED, { liveDir, desktopDir, kind: "background" });
  expect(closed.ok && closed.command.slice(3)).toEqual([homedir(), CLOSED]);
  const interactive = await planOpen(ID, { liveDir, desktopDir, ttyOf: async () => "ttys003", kind: "interactive" });
  expect(interactive.ok && interactive.command[3]).toBe("/dev/ttys003");
});

test("a named background session looks for its existing Terminal tab before attaching", async () => {
  const name = `it's "odd" $(touch pwned)`;
  const plan = await planOpen(ID, { liveDir, desktopDir, kind: "background", name });
  if (!plan.ok) throw new Error(plan.error);
  const [bin, flag, script, ...argv] = plan.command;
  expect([bin, flag]).toEqual(["osascript", "-e"]);
  expect(argv).toEqual([ID.slice(0, 8), name]); // the name is an argv item, never part of the script
  expect(script).toContain("custom title");
  expect(script).toContain("claude attach");
  for (const part of ["odd", "pwned", ID.slice(0, 8)]) expect(script).not.toContain(part);
});

test("a background session without a name attaches as before", async () => {
  for (const name of [undefined, ""]) {
    const plan = await planOpen(ID, { liveDir, desktopDir, kind: "background", name });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.command.slice(3)).toEqual([ID.slice(0, 8)]);
    expect(plan.command[2]).not.toContain("custom title");
  }
});

test("the name never changes the interactive or closed paths", async () => {
  const interactive = await planOpen(ID, { liveDir, desktopDir, ttyOf: async () => "ttys003", kind: "interactive", name: "x" });
  expect(interactive.ok && interactive.command.slice(3)).toEqual(["/dev/ttys003"]);
  const closed = await planOpen(CLOSED, { liveDir, desktopDir, kind: "background", name: "x" });
  expect(closed.ok && closed.command.slice(3)).toEqual([homedir(), CLOSED]);
});

test("a command that never finishes is killed and reported as timed out", async () => {
  const started = Date.now();
  expect(await run(["sleep", "30"], 50)).toEqual({ ok: false, error: "timed out" });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await run(["true"], 5000)).toEqual({ ok: true, command: ["true"] });
});

test("a new Terminal tab runs a fixed script with no arguments", async () => {
  let command: string[] = [];
  const result = await openTerminalTab(async (c) => ((command = c), { ok: true, command: c }));
  expect(result.ok).toBe(true);
  expect(command.slice(0, 2)).toEqual(["osascript", "-e"]);
  expect(command).toHaveLength(3);
});
