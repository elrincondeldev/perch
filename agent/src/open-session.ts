/**
 * Opens a session in the Claude desktop app.
 * - Known to the app (running or stopped while idle): navigate with the undocumented
 *   `claude://code/continue?session=local_…`; the app restarts the session if needed.
 * - Unknown to the app and closed: `claude --desktop --resume <id>` (documented, CLI ≥ 2.1.285).
 *   Without the desktop app: `claude --resume <id>` in a new Terminal.app tab, in the session's folder.
 * - A live background session (`claude --bg`): focuses a Terminal tab already titled with its name,
 *   else `claude attach` in a new tab.
 * - Running in a terminal: brings the Terminal.app tab on its tty to the front. Without a tty it is
 *   refused, since resuming it would start a second process on the same conversation.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { DESKTOP_SESSIONS_DIR, findDesktopSession, hasDesktopApp } from "./desktop-sessions.ts";
import { BACKGROUND_KIND, type SessionKind } from "../../shared/protocol.ts";
import { isSessionId } from "./protocol-guard.ts";

const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const LIVE_DIR = `${homedir()}/.claude/sessions`;
const TTY = /^ttys\d+$/;

// The scripts get session data ONLY as argv, never interpolated into their source. They are built from the
// small pieces below; `indent` only keeps the generated source readable.
const indent = (text: string, tabs: number) =>
  text
    .split("\n")
    .map((line) => (line ? "\t".repeat(tabs) + line : line))
    .join("\n");

/**
 * Runs `body` once per tab of every Terminal window, with `w` the window and `t` the tab. The `try` skips
 * windows without tabs, which fail with -1728 when asked for them.
 */
const forEachTab = (body: string) => `repeat with w in windows
	set windowTabs to {}
	try
		set windowTabs to tabs of w
	end try
	repeat with t in windowTabs
${indent(body, 2)}
	end repeat
end repeat`;

/** Brings a tab, and the window holding it, to the front. */
const raiseTab = (window: string, tab: string) => `set miniaturized of ${window} to false
set selected of ${tab} to true
set index of ${window} to 1
activate`;

// Focuses the tab on a tty: argv is the tty.
const FOCUS_TERMINAL_TAB = `on run argv
	set target to item 1 of argv
	if application "Terminal" is not running then error "Terminal is not running"
	tell application "Terminal"
${indent(
  forEachTab(`if tty of t is target then
${indent(raiseTab("w", "t"), 1)}
	return "focused " & target
end if`),
  2,
)}
	end tell
	error "no Terminal tab on " & target
end run`;

// Terminal's dictionary has no "new tab": `do script ""` opens a shell in a new window, which macOS
// files as a tab of the front window when "Prefer tabs when opening documents" is Always. A Terminal
// that isn't running opens its own window at launch, so then it is only activated.
const NEW_TERMINAL_TAB = `if application "Terminal" is running then
	tell application "Terminal"
		do script ""
		activate
	end tell
else
	tell application "Terminal" to activate
end if`;

// Runs a command in Terminal the way NEW_TERMINAL_TAB opens a shell. `commandExpression` is fixed source
// that builds the command from argv through `quoted form of`; the values never reach this source.
// `beforeOpening` runs first, inside the `tell`, and may return to skip opening anything. A Terminal that
// isn't running opens its own window at launch: the command runs there rather than in a second window.
const inTerminal = (commandExpression: string, beforeOpening = "") => `on run argv
	set command to ${commandExpression}
	if application "Terminal" is running then
		tell application "Terminal"
${beforeOpening ? `${indent(beforeOpening, 3)}\n` : ""}			do script command
			activate
		end tell
	else
		tell application "Terminal"
			activate
			repeat 50 times -- up to 5 s for the startup window
				if (count of windows) > 0 then exit repeat
				delay 0.1
			end repeat
			do script command in window 1
		end tell
	end if
end run`;

// Resumes a closed session, in its folder: argv is the folder, then the session id.
const RESUME_IN_TERMINAL = inTerminal(
  `"cd " & quoted form of (item 1 of argv) & " && claude --resume " & quoted form of (item 2 of argv)`,
);

const ATTACH_COMMAND = `"claude attach " & quoted form of (item 1 of argv)`;

// Attaches to a background session: argv is its id.
const ATTACH_IN_TERMINAL = inTerminal(ATTACH_COMMAND);

// Same, but first looks for a tab that already shows the session. Claude Code titles its tabs
// "<status glyph> <session name>", so a tab matches when its custom title is the name (item 2 of argv)
// or the name after the first two characters. If any tab matches (the last one found: several usually
// mean duplicates of this session) it is brought to the front and nothing is opened; otherwise the
// attach runs.
const FOCUS_OR_ATTACH_IN_TERMINAL = inTerminal(
  ATTACH_COMMAND,
  `set wanted to item 2 of argv
set matchCount to 0
set matchWindow to missing value
set matchTab to missing value
${forEachTab(`set tabTitle to ""
try
	set tabTitle to custom title of t
end try
set isMatch to (tabTitle is wanted)
if not isMatch and (length of tabTitle) > 2 then
	if character 2 of tabTitle is " " and (text 3 thru -1 of tabTitle) is wanted then set isMatch to true
end if
if isMatch then
	set matchCount to matchCount + 1
	set matchWindow to w
	set matchTab to t
end if`)}
if matchCount > 0 then
${indent(raiseTab("matchWindow", "matchTab"), 1)}
	return "focused"
end if`,
);

/** How `claude agents`, `claude attach` and `claude stop` name a background session: the first 8 characters of its id. */
export const backgroundId = (sessionId: string) => sessionId.slice(0, 8);

/** What `openSession` knows about the session beyond its id. */
export interface OpenOptions {
  /** Where the session last ran. */
  cwd?: string;
  /** What `claude agents` says the session is, if known. */
  kind?: SessionKind;
  /** The session's title, which Claude Code also uses as its Terminal tab title; not the label the panel shows. */
  name?: string;
}

export type OpenResult = { ok: true; command: string[] } | { ok: false; error: string };

interface LiveSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  entrypoint?: string;
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch {
    return false;
  }
}

/** Every ~/.claude/sessions/<pid>.json the CLI left behind, running or not. */
async function readSessionFiles(dir: string): Promise<LiveSession[]> {
  const infos: LiveSession[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const info: LiveSession | null = await Bun.file(`${dir}/${name}`).json().catch(() => null);
    if (info && typeof info.pid === "number" && typeof info.sessionId === "string") infos.push(info);
  }
  return infos;
}

/** Session id → pid of the CLI process, as the CLI recorded it; the process may be gone. */
export async function sessionPids(dir = LIVE_DIR): Promise<Map<string, number>> {
  const pids = new Map<string, number>();
  // A resumed session leaves its old file behind: a running pid beats a dead one.
  for (const info of await readSessionFiles(dir)) {
    const known = pids.get(info.sessionId);
    if (known === undefined || !isAlive(known)) pids.set(info.sessionId, info.pid);
  }
  return pids;
}

/** A running Claude Code process for this session, from the CLI's internal ~/.claude/sessions/<pid>.json. */
async function findLive(id: string, dir: string): Promise<LiveSession | undefined> {
  return (await readSessionFiles(dir)).find((info) => info.sessionId === id && isAlive(info.pid));
}

/** The folder the CLI recorded for a session, even after its process exited. */
async function recordedCwd(id: string, dir: string): Promise<string | undefined> {
  return (await readSessionFiles(dir)).find((info) => info.sessionId === id && info.cwd)?.cwd;
}

/** Controlling terminal of a process, like "ttys003" ("??" when it has none). */
export async function processTty(pid: number): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["ps", "-o", "tty=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Picks the command that would open the session, without running it. `cwd` is where it last ran. */
export async function planOpen(
  sessionId: string,
  {
    cwd,
    liveDir = LIVE_DIR,
    desktopDir = DESKTOP_SESSIONS_DIR,
    ttyOf = processTty,
    kind,
    name,
  }: OpenOptions & {
    liveDir?: string;
    desktopDir?: string;
    ttyOf?: (pid: number) => Promise<string | undefined>;
  } = {},
): Promise<OpenResult> {
  if (!isSessionId(sessionId)) return { ok: false, error: "invalid session id" };

  const desktop = await findDesktopSession(sessionId, desktopDir);
  if (desktop && LOCAL_ID.test(desktop.localId)) {
    return { ok: true, command: ["open", `claude://code/continue?session=${desktop.localId}`] };
  }
  const live = await findLive(sessionId, liveDir);
  if (live) {
    // Background sessions run in a pty the Claude daemon owns: no tty to focus. A tab may still show
    // them (a plain client), found by title; otherwise attach in a new one.
    if (kind === BACKGROUND_KIND) {
      const id = backgroundId(sessionId);
      return {
        ok: true,
        command: name ? ["osascript", "-e", FOCUS_OR_ATTACH_IN_TERMINAL, id, name] : ["osascript", "-e", ATTACH_IN_TERMINAL, id],
      };
    }
    const tty = await ttyOf(live.pid);
    if (tty && TTY.test(tty)) return { ok: true, command: ["osascript", "-e", FOCUS_TERMINAL_TAB, `/dev/${tty}`] };
    return { ok: false, error: `running outside the desktop app (${live.entrypoint}, pid ${live.pid}): open it in its terminal` };
  }
  if (hasDesktopApp(desktopDir)) return { ok: true, command: ["claude", "--desktop", "--resume", sessionId] };
  const folder = cwd || (await recordedCwd(sessionId, liveDir)) || desktop?.cwd || homedir();
  return { ok: true, command: ["osascript", "-e", RESUME_IN_TERMINAL, folder, sessionId] };
}

export async function openSession(sessionId: string, options: OpenOptions = {}): Promise<OpenResult> {
  const plan = await planOpen(sessionId, options);
  return plan.ok ? run(plan.command) : plan;
}

/** Opens a shell, without Claude, in a new Terminal.app tab (a window unless macOS prefers tabs). `runner` is replaceable for tests. */
export function openTerminalTab(runner: (command: string[]) => Promise<OpenResult> = run): Promise<OpenResult> {
  return runner(["osascript", "-e", NEW_TERMINAL_TAB]);
}

/** A hung `claude stop` or osascript (e.g. a beachballed Terminal) must not hold its caller for minutes. */
const COMMAND_TIMEOUT_MS = 15_000;

export async function run(command: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<OpenResult> {
  const proc = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (timedOut) return { ok: false, error: "timed out" };
    if (code !== 0) {
      const detail = stderr.trim().slice(0, 200);
      return { ok: false, error: `${command[0]} exited with ${code}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true, command };
  } finally {
    clearTimeout(timer);
  }
}
