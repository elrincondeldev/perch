/**
 * Sessions in Ghostty terminals. Opening one brings its panel to the front: the terminal whose
 * tty matches the session's Claude process or one of its ancestors. When no panel matches, or
 * the session isn't running, it only activates Ghostty; it never starts, resumes or types into
 * a session. With a workspace in config.json, only the sessions in it are tracked.
 */
import type { LibraryEntry } from "../../shared/protocol.ts";
import { followGhosttyFocus } from "./ghostty-focus.ts";
import { focusPanel, processTable, ttyChain, type ProcessTable } from "./ghostty.ts";
import { LIBRARY_SIZE, type SessionHost } from "./host.ts";
import type { SessionHub } from "./hub.ts";
import type { AgentEntry } from "./state.ts";
import { workspaceAgents } from "./workspace-sessions.ts";

/** `workspace` limits the sessions tracked; the rest is replaceable so tests don't touch Ghostty or run `claude agents`. */
export interface GhosttyDeps {
  workspace?: string | null;
  list?: () => Promise<AgentEntry[]>;
  table?: () => Promise<ProcessTable>;
  focus?: (ttys: string[]) => Promise<boolean>;
  watch?: (onTty: (tty: string | null) => void) => () => void;
}

export function ghosttyHost(
  hub: SessionHub,
  { workspace = null, list = () => workspaceAgents(workspace), table = processTable, focus = focusPanel, watch }: GhosttyDeps = {},
): SessionHost {
  return {
    id: "ghostty",
    reopensUnderNewId: true,
    sessions: list,

    async open(sessionId) {
      const pid = hub.pidOf(sessionId);
      try {
        const ttys = pid === null ? [] : ttyChain(pid, await table());
        if (await focus(ttys)) return { focused: true };
      } catch (error) {
        return { focused: false, message: `Ghostty: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { focused: false, message: pid === null ? "not running; showed Ghostty" : "no Ghostty panel found; showed Ghostty" };
    },

    followFocus: () => followGhosttyFocus(hub, { watch, table }),

    /** Fresh from `claude agents`; the hub takes them in first, so each one can be pinned. */
    async library(): Promise<LibraryEntry[]> {
      const agents = await list();
      hub.handleAgents(agents);
      return agents
        .flatMap((agent) => {
          const s = hub.get(agent.sessionId);
          return s ? [{ id: s.id, name: s.name, cwd: s.cwd, lastActivityAt: s.stateSince, pinned: s.pinned }] : [];
        })
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .slice(0, LIBRARY_SIZE);
    },

    async adopt() {},
  };
}
