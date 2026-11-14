/**
 * Follows which session is in front in Terminal.app: every couple of seconds, one osascript call asks
 * for the tty and custom title of the selected tab of the front window, only if Terminal is running and
 * frontmost. The tty is mapped to a live session through the pid the CLI recorded in ~/.claude/sessions;
 * a tab on no session's tty (a client attached to a background session) is matched by its title instead.
 */
import { homedir } from "node:os";
import { isAlive, processTty, sessionPids } from "./open-session.ts";

// `is running` is asked outside any `tell`, so asking never launches Terminal; and without System Events
// there is no Accessibility prompt. An empty answer means "nothing of ours in front". Otherwise the first
// line is the front tab ("<tty> TAB <title>") and every further line is one tab's custom title, windows
// whose tabs cannot be read (error -1728) being skipped. Read-only.
const FRONT_TTY = `if application "Terminal" is not running then return ""
tell application "Terminal"
	if not frontmost then return ""
	set frontLine to ""
	try
		set t to selected tab of front window
		set tabTitle to ""
		try
			set tabTitle to custom title of t
		end try
		set frontLine to (tty of t) & (ASCII character 9) & tabTitle
	end try
	set out to frontLine
	repeat with w in windows
		try
			repeat with tb in tabs of w
				try
					set out to out & linefeed & (custom title of tb)
				end try
			end repeat
		end try
	end repeat
	return out
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
  /** Returns the front tab as "<tty>\t<custom title>" (tty like "/dev/ttys003"), then one line per tab title; "" when Terminal isn't in front. Replaceable for tests. */
  run?: () => Promise<string>;
  /** Called with the custom title of every Terminal tab each time Terminal is in front (not when it isn't). */
  onTabs?: (titles: string[]) => void;
  /** Maps a tty to the live session on it. */
  sessionForTty?: (tty: string) => Promise<string | null>;
  /** Maps a tab's custom title, with its status glyph already stripped, to the one live session with that name. */
  sessionForTitle?: (name: string) => string | null;
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

/** Claude Code titles its tabs "<status glyph> <session name>"; an untitled-by-glyph tab is the bare name. */
export function titleCandidates(title: string): string[] {
  const names = [title];
  if (title.length > 2 && title[1] === " ") names.push(title.slice(2));
  return names;
}

/** Splits the script's answer into the front tab (null when unreadable) and the titles of all tabs. */
export function parseTerminalOutput(out: string): { front: { tty: string; title: string } | null; titles: string[] } {
  const [first = "", ...rest] = out.split("\n");
  const [tty = "", title = ""] = first.split("\t");
  return { front: tty ? { tty, title } : null, titles: rest.filter((line) => line !== "") };
}

/** The background sessions shown in some tab: a tab title is the session's real title, with or without the status glyph. */
export function sessionsInTabs(titles: string[], sessions: { id: string; title: string | null; background: boolean }[]): Set<string> {
  const shown = new Set(titles.flatMap(titleCandidates));
  return new Set(sessions.filter((s) => s.background && s.title !== null && shown.has(s.title)).map((s) => s.id));
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
    onTabs,
    sessionForTty = ttyResolver(),
    sessionForTitle = () => null,
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
          const out = await run();
          const { front, titles } = parseTerminalOutput(out);
          if (out !== "") onTabs?.(titles);
          const { tty, title } = front ?? { tty: "", title: "" };
          let id = tty ? await sessionForTty(tty) : null;
          if (!id && title) {
            for (const name of titleCandidates(title)) {
              id = sessionForTitle(name);
              if (id) break;
            }
          }
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
