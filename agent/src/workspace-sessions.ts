/**
 * Running Claude Code sessions from `claude agents --json` (documented), optionally limited to a
 * workspace folder, so sessions started elsewhere (background helpers, other projects) stay off
 * the strip.
 */
import { $ } from "bun";
import type { AgentEntry } from "./state.ts";

export type AgentLister = () => Promise<AgentEntry[]>;

export const claudeAgents: AgentLister = () => $`claude agents --json`.quiet().json();

/** True when `cwd` is `root` itself or a folder inside it. */
export function isInside(cwd: string, root: string) {
  const base = root.replace(/\/+$/, "");
  return cwd === base || cwd.startsWith(`${base}/`);
}

/** The running sessions in `root` or below; all of them when `root` is null. */
export async function workspaceAgents(root: string | null, list: AgentLister = claudeAgents): Promise<AgentEntry[]> {
  const agents = await list();
  return root === null ? agents : agents.filter((agent) => typeof agent.cwd === "string" && isInside(agent.cwd, root));
}
