import type { SessionHostId } from "../../shared/protocol.ts";
import { parseHost } from "./host.ts";

export type Command =
  | { name: "agent"; lan: boolean }
  | { name: "setup"; pi: boolean; host: SessionHostId | null }
  | { name: "host"; host: SessionHostId | null }
  | { name: "status" }
  | { name: "uninstall"; purge: boolean }
  | { name: "version" }
  | { name: "help"; error?: string };

export const USAGE = `Usage: tomari <command>

  setup [--pi] [--host app|ghostty]
                       install the agent, the strip and the Claude Code hooks, and start them
                       --pi also lets a claude-panel Raspberry Pi connect over the LAN
                       --host chooses where sessions are opened (see host)
  host [app|ghostty]   show or choose where sessions are opened: the Claude desktop app, or
                       Ghostty terminals. A running agent switches at once, without a restart
  status               show what is installed and running
  uninstall [--purge]  remove everything; --purge also deletes pins and icons without asking
  agent [--lan]        run the agent in the foreground (what the LaunchAgent runs)
  version              print the version`;

const UNKNOWN_HOST = (value: string) => `unknown host: ${value} (app or ghostty)`;

const FLAGS: Record<string, Record<string, string>> = {
  agent: { "--lan": "lan" },
  setup: { "--pi": "pi" },
  status: {},
  uninstall: { "--purge": "purge" },
};

export function parseCommand(args: string[]): Command {
  const [name, ...rest] = args;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") return { name: "help" };
  if (name === "version" || name === "--version" || name === "-v") return { name: "version" };
  if (name === "host") {
    if (rest.length > 1) return { name: "help", error: "host takes one of: app, ghostty" };
    if (rest[0] === undefined) return { name: "host", host: null };
    const host = parseHost(rest[0]);
    return host ? { name: "host", host } : { name: "help", error: UNKNOWN_HOST(rest[0]) };
  }
  const allowed = FLAGS[name];
  if (!allowed) return { name: "help", error: `unknown command: ${name}` };

  const command: Record<string, unknown> = { name };
  for (const key of Object.values(allowed)) command[key] = false;
  if (name === "setup") command.host = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (name === "setup" && arg === "--host") {
      const value = rest[++i];
      if (value === undefined) return { name: "help", error: "--host takes app or ghostty" };
      command.host = parseHost(value);
      if (!command.host) return { name: "help", error: UNKNOWN_HOST(value) };
      continue;
    }
    const key = allowed[arg];
    if (!key) return { name: "help", error: `unknown option for ${name}: ${arg}` };
    command[key] = true;
  }
  return command as Command;
}
