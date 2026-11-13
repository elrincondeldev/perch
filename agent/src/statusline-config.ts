import { HOOK_PORT } from "./config.ts";
import type { Settings } from "./hooks-config.ts";

export const STATUSLINE_URL = `http://127.0.0.1:${HOOK_PORT}/statusline`;

/**
 * Claude Code runs one `statusLine` command and pipes it a JSON document. Ours copies that JSON to the
 * agent, then runs the command the user had, if any, on the same input, so their statusline looks as before.
 * Only POSIX sh: the command may run under any shell. `curl … || true` stays silent when the agent is down.
 */
function head(url: string) {
  return `# tomari: sends Claude Code's usage data to the Tomari agent, then runs the command below, if any
input=$(cat)
printf '%s' "$input" | /usr/bin/curl -s -m 1 -H 'Content-Type: application/json' --data-binary @- ${url} >/dev/null 2>&1 || true`;
}
const CHAIN_OPEN = `\nprintf '%s' "$input" | {\n`;
const CHAIN_CLOSE = `\n}`;

/** The command to install; `previous` is the user's own command, or null when they had none. */
export function wrapStatusline(previous: string | null, url = STATUSLINE_URL): string {
  return head(url) + (previous === null ? "" : CHAIN_OPEN + previous + CHAIN_CLOSE);
}

/**
 * The user's command inside one of ours: null when ours wraps nothing, undefined when `command`
 * isn't one of ours. Exactly undoes `wrapStatusline`.
 */
export function unwrapStatusline(command: unknown, url = STATUSLINE_URL): string | null | undefined {
  const start = head(url);
  if (typeof command !== "string" || !command.startsWith(start)) return undefined;
  const rest = command.slice(start.length);
  if (rest === "") return null;
  if (rest.length >= CHAIN_OPEN.length + CHAIN_CLOSE.length && rest.startsWith(CHAIN_OPEN) && rest.endsWith(CHAIN_CLOSE)) {
    return rest.slice(CHAIN_OPEN.length, rest.length - CHAIN_CLOSE.length);
  }
  return undefined;
}

type StatusLine = { type?: unknown; command?: unknown; [k: string]: unknown };

const isObject = (value: unknown): value is StatusLine => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `settings` with our statusline added, wrapped around the user's command, or taken out again with
 * theirs restored. Anything that isn't a plain `command` statusline is left alone.
 */
export function mergeStatusLine(settings: Settings, { install }: { install: boolean }): Settings {
  const current = settings.statusLine;
  const own = isObject(current) ? unwrapStatusline(current.command) : undefined;

  if (install) {
    if (own !== undefined) return settings; // already ours
    if (current === undefined) return { ...settings, statusLine: { type: "command", command: wrapStatusline(null) } };
    if (isObject(current) && current.type === "command" && typeof current.command === "string") {
      const previous = current.command.trim() === "" ? null : current.command;
      return { ...settings, statusLine: { ...current, command: wrapStatusline(previous) } };
    }
    return settings;
  }

  if (own === undefined) return settings;
  if (own === null) {
    const { statusLine: _, ...rest } = settings;
    return rest;
  }
  return { ...settings, statusLine: { ...(current as StatusLine), command: own } };
}

export function hasOwnStatusLine(settings: Settings) {
  return isObject(settings.statusLine) && unwrapStatusline(settings.statusLine.command) !== undefined;
}
