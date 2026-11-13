/**
 * Ghostty through its AppleScript dictionary (Ghostty 1.4: windows → tabs → terminals, each
 * terminal with its `tty`). A session is matched to its panel by tty: the tty of its Claude
 * process, or of an ancestor when Claude runs inside another program on the panel (nvim's
 * terminal, for one). The scripts check that Ghostty is running before asking it anything,
 * because an Apple Event to an app that isn't running launches it.
 */
import { $ } from "bun";

export interface ProcessInfo {
  ppid: number;
  /** "/dev/ttys001", or null for a process without a terminal. */
  tty: string | null;
}
export type ProcessTable = Map<number, ProcessInfo>;

/** Parses `ps -axo pid=,ppid=,tty=`. */
export function parseProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    const [pid, ppid, tty] = line.trim().split(/\s+/);
    if (!pid || !ppid || !Number.isInteger(Number(pid))) continue;
    table.set(Number(pid), { ppid: Number(ppid), tty: tty && tty !== "??" ? `/dev/${tty}` : null });
  }
  return table;
}

export async function processTable(): Promise<ProcessTable> {
  return parseProcessTable(await $`ps -axo pid=,ppid=,tty=`.quiet().text());
}

/** The ttys of `pid` and its ancestors, nearest first, without repeats. */
export function ttyChain(pid: number, table: ProcessTable): string[] {
  const ttys: string[] = [];
  const seen = new Set<number>();
  for (let current = pid; current > 1 && !seen.has(current); ) {
    seen.add(current);
    const info = table.get(current);
    if (!info) break;
    if (info.tty && !ttys.includes(info.tty)) ttys.push(info.tty);
    current = info.ppid;
  }
  return ttys;
}

/** The session whose Claude process runs on `tty`, or under a program that does. */
export function sessionOnTty(tty: string, sessions: { id: string; pid: number }[], table: ProcessTable): string | null {
  return sessions.find((s) => ttyChain(s.pid, table).includes(tty))?.id ?? null;
}

// `tab` is a Ghostty class inside its tell blocks, so the scripts avoid the tab character.
const FOCUS_SCRIPT = `on run argv
	if application "Ghostty" is running then
		tell application "Ghostty"
			set panels to every terminal
			set ttys to {}
			repeat with panel in panels
				set end of ttys to tty of (contents of panel)
			end repeat
			repeat with wanted in argv
				repeat with i from 1 to count of panels
					if item i of ttys is (contents of wanted) then
						focus (item i of panels)
						activate
						return "focused"
					end if
				end repeat
			end repeat
		end tell
	end if
	tell application "Ghostty" to activate
	return "activated"
end run`;

/** Focuses the first Ghostty panel on one of `ttys`, in order; when none matches, only activates Ghostty. True if it focused a panel. */
export async function focusPanel(ttys: string[]): Promise<boolean> {
  return (await osascript(FOCUS_SCRIPT, ttys)) === "focused";
}

/** Marker in the watcher's command line, so a stray watcher can be found and stopped (`pkill -f`). */
export const WATCHER_MARKER = "tomari focus watcher";

/**
 * JXA that prints the tty of the front window's focused panel every `seconds`, empty when there
 * is none. It exits once its parent, the agent, is gone (even after a kill -9): its parent pid
 * changes. A failed write would not stop it, since osascript survives a closed stderr.
 */
export function watcherScript(seconds = 1) {
  return `// ${WATCHER_MARKER}
ObjC.bindFunction("getppid", ["int", []]);
function run() {
  const agent = $.getppid();
  const ghostty = Application("Ghostty");
  while ($.getppid() === agent) {
    let tty = "";
    if (ghostty.running()) {
      try {
        tty = ghostty.frontWindow().selectedTab().focusedTerminal().tty();
      } catch (e) {}
    }
    console.log("tty:" + tty);
    delay(${seconds});
  }
}`;
}

/** A watcher line: the tty, null for no panel, or undefined when the line isn't a report (an osascript error). */
export function parseWatcherLine(line: string): string | null | undefined {
  if (!line.startsWith("tty:")) return undefined;
  return line.slice(4).trim() || null;
}

/**
 * Calls `onTty` with the focused panel's tty each time it changes, from one long-lived osascript
 * (a fresh osascript per check would cost far more CPU). Restarts it if it dies. Returns a stop function.
 */
export function watchFocusedTty(onTty: (tty: string | null) => void, { seconds = 1, retryMs = 5000 } = {}) {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let last: string | null | undefined;

  (async () => {
    while (!stopped) {
      proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", watcherScript(seconds)], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      let complaint = "";
      for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
        const tty = parseWatcherLine(line);
        if (tty === undefined) complaint ||= line.trim();
        else if (tty !== last) onTty((last = tty));
      }
      const code = await proc.exited;
      if (stopped) return;
      console.error(`Ghostty focus watcher exited with ${code}${complaint ? `: ${complaint.slice(0, 200)}` : ""}; retrying`);
      await Bun.sleep(retryMs);
    }
  })();

  return () => {
    stopped = true;
    proc?.kill();
  };
}

async function osascript(script: string, args: string[] = []): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", script, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim().slice(0, 200) || `osascript exited with ${code}`);
  return out.trim();
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true });
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
    }
  }
  if (buffer) yield buffer;
}
