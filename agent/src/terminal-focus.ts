/**
 * Follows which session is in front in Terminal.app: every couple of seconds, one osascript call asks
 * for the tty of the selected tab of the front window, only if Terminal is running and frontmost.
 * That tty is mapped to a live session through the pid the CLI recorded in ~/.claude/sessions.
 */
import { homedir } from "node:os";
import { isAlive, processTty, sessionPids } from "./open-session.ts";

// `is running` is asked outside any `tell`, so asking never launches Terminal; and without System Events
// there is no Accessibility prompt. An empty answer means "nothing of ours in front".
const FRONT_TTY = `if application "Terminal" is not running then return ""
tell application "Terminal"
	if not frontmost then return ""
	try
		return tty of selected tab of front window
	on error
		return ""
	end try
end tell`;

export interface TerminalFocusOptions {
  intervalMs?: number;
  /** After a failed osascript call, how long to wait before trying again; it doubles on each further failure. */
  backoffMs?: number;
  /** The longest the backoff grows to. */
  maxBackoffMs?: number;
  /** The session currently focused, wherever that came from (e.g. the hub); defaults to the one this watcher last reported. */
  current?: () => string | null;
  /** Waits between ticks. Replaceable for tests. */
  sleep?: (ms: number) => Promise<unknown>;
  /** Polled each tick; false skips it without spawning anything, e.g. while Terminal is not in front. */
  enabled?: () => boolean;
  /** Subscribes `wake` to whatever should end the wait early, e.g. Terminal coming to the front; returns an unsubscribe. */
  wakeOn?: (wake: () => void) => () => void;
  /** Returns the front tab's tty like "/dev/ttys003", or "" when Terminal isn't in front. Replaceable for tests. */
  run?: () => Promise<string>;
  /** Maps a tty to the live session on it. */
  sessionForTty?: (tty: string) => Promise<string | null>;
  /** Whether a session is still running; the focus is cleared once the focused one is not. Defaults to always. */
  alive?: (sessionId: string) => boolean;
  log?: (message: string) => void;
}

async function runFrontTty(): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", FRONT_TTY], { stdout: "pipe", stderr: "pipe" });
  // A beachballed Terminal would hold the AppleEvent for about 2 minutes; give up sooner and back off.
  const timer = setTimeout(() => proc.kill(), 10_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).finally(() =>
    clearTimeout(timer),
  );
  if (code !== 0) throw new Error(`osascript exited with ${code}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ""}`);
  return out.trim();
}

/** pid → tty never changes for a process, so ps runs once per session. */
export function ttyResolver({
  pids = () => sessionPids(`${homedir()}/.claude/sessions`),
  ttyOf = processTty,
  alive = isAlive,
}: {
  pids?: () => Promise<Map<string, number>>;
  ttyOf?: (pid: number) => Promise<string | undefined>;
  alive?: (pid: number) => boolean;
} = {}) {
  const ttys = new Map<number, string>();
  return async (tty: string): Promise<string | null> => {
    const current = await pids();
    const seen = new Set(current.values());
    for (const pid of ttys.keys()) if (!seen.has(pid)) ttys.delete(pid); // gone, or its pid may be reused
    for (const [id, pid] of current) {
      if (!alive(pid)) continue;
      if (!ttys.has(pid)) {
        const found = await ttyOf(pid); // a failed lookup isn't cached, so the next tick retries it
        if (found) ttys.set(pid, found);
      }
      if (tty === `/dev/${ttys.get(pid)}`) return id;
    }
    return null;
  };
}

/**
 * Calls `onFocus` with the session last selected in Terminal.app, only when that changes. Like the desktop
 * source it is sticky: switching to another app, or to a tab with no Claude session, keeps the last one;
 * it goes to null only when that session ends. Returns a stop function.
 */
export function watchTerminalFocus(
  onFocus: (sessionId: string | null) => void,
  {
    intervalMs = 2000,
    backoffMs = 10_000,
    maxBackoffMs = 60_000,
    enabled = () => true,
    wakeOn,
    run = runFrontTty,
    sessionForTty = ttyResolver(),
    alive = () => true,
    log = (message) => console.error(message),
    sleep = Bun.sleep,
    current,
  }: TerminalFocusOptions = {},
) {
  let stopped = false;
  let reported: string | null = null;
  const focused = current ?? (() => reported);
  let failures = 0;
  let wakeUp: (() => void) | undefined;
  let woken = false; // a wake-up during a tick must not be lost
  const unsubscribe = wakeOn?.(() => {
    woken = true;
    wakeUp?.();
  });

  (async () => {
    while (!stopped) {
      let wait = intervalMs;
      if (enabled()) {
        try {
          const tty = await run();
          const id = tty ? await sessionForTty(tty) : null;
          // Compared with the focus as it stands, not with what this watcher reported: opening a session
          // from the panel moves the focus too, and returning to the tab it left must win it back.
          const now = focused();
          if (id && id !== now) {
            reported = id;
            onFocus(id);
          } else if (now && !alive(now)) {
            reported = null;
            onFocus(null);
          }
          failures = 0;
        } catch (error) {
          wait = Math.min(backoffMs * 2 ** failures, maxBackoffMs);
          if (failures === 0) log(`terminal focus failing, backing off: ${error instanceof Error ? error.message : String(error)}`);
          failures++;
        }
      }
      if (!woken) await Promise.race([sleep(wait), new Promise<void>((resolve) => (wakeUp = resolve))]);
      wakeUp = undefined;
      woken = false;
    }
  })();

  return () => {
    stopped = true;
    unsubscribe?.();
    wakeUp?.();
  };
}
