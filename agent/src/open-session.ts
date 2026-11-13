/**
 * Opens a session in the Claude desktop app.
 * - Known to the app (running or stopped while idle): navigate with the undocumented
 *   `claude://code/continue?session=local_…`; the app restarts the session if needed.
 * - Unknown to the app and closed: `claude --desktop --resume <id>` (documented, CLI ≥ 2.1.285).
 * - Running in a terminal: refused, since resuming it would start a second process on the same conversation.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { DESKTOP_SESSIONS_DIR, findDesktopSession } from "./desktop-sessions.ts";
import { isSessionId } from "./protocol-guard.ts";

const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const LIVE_DIR = `${homedir()}/.claude/sessions`;

/** `inTerminal` marks a refusal because the session is running in a terminal, where it can be brought forward instead. */
export type OpenResult = { ok: true; command: string[] } | { ok: false; error: string; inTerminal?: true };

interface LiveSession {
  pid: number;
  sessionId: string;
  entrypoint?: string;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch {
    return false;
  }
}

/** A running Claude Code process for this session, from the CLI's internal ~/.claude/sessions/<pid>.json. */
async function findLive(id: string, dir: string): Promise<LiveSession | undefined> {
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const info: LiveSession | null = await Bun.file(`${dir}/${name}`).json().catch(() => null);
    if (info?.sessionId === id && isAlive(info.pid)) return info;
  }
}

/** Picks the command that would open the session, without running it. */
export async function planOpen(
  sessionId: string,
  { liveDir = LIVE_DIR, desktopDir = DESKTOP_SESSIONS_DIR } = {},
): Promise<OpenResult> {
  if (!isSessionId(sessionId)) return { ok: false, error: "invalid session id" };

  const desktop = await findDesktopSession(sessionId, desktopDir);
  if (desktop && LOCAL_ID.test(desktop.localId)) {
    return { ok: true, command: ["open", `claude://code/continue?session=${desktop.localId}`] };
  }
  const live = await findLive(sessionId, liveDir);
  if (live) {
    return { ok: false, error: `running outside the desktop app (${live.entrypoint}, pid ${live.pid}): open it in its terminal`, inTerminal: true };
  }
  return { ok: true, command: ["claude", "--desktop", "--resume", sessionId] };
}

/** `cwd` is the session's folder: `claude --resume` looks for the session in the project it runs in. */
export async function openSession(sessionId: string, cwd?: string): Promise<OpenResult> {
  const plan = await planOpen(sessionId);
  if (!plan.ok) return plan;

  const { code, output } = await runOnTerminal(plan.command, cwd);
  if (code !== 0) return { ok: false, error: `${plan.command[0]} exited with ${code}${output ? `: ${output.slice(0, 200)}` : ""}` };
  return plan;
}

/**
 * Runs a command on a pseudo-terminal and returns what it printed, without escape sequences:
 * `claude --desktop` refuses to run with redirected output. A `cwd` that no longer exists is ignored.
 */
export async function runOnTerminal(command: string[], cwd?: string): Promise<{ code: number; output: string }> {
  const decoder = new TextDecoder();
  let output = "";
  const proc = Bun.spawn(command, {
    cwd: cwd && existsSync(cwd) ? cwd : undefined,
    terminal: { cols: 200, rows: 24, data: (_terminal, chunk) => void (output += decoder.decode(chunk, { stream: true })) },
  });
  const code = await proc.exited;
  return { code, output: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trim() };
}
