/**
 * Sessions in the Claude desktop app. The app keeps a session's id for as long as it lists it,
 * and stops its process while it sits idle, so the + menu also offers sessions that aren't
 * running: pinning one adopts it from the app's metadata. A session still running in a terminal
 * is never resumed in the app, which would start a second process on the same conversation: it
 * is brought to the front where it runs.
 */
import { basename } from "node:path";
import type { LibraryEntry } from "../../shared/protocol.ts";
import { watchDesktopFocus } from "./desktop-focus.ts";
import { openSession, type OpenResult as DesktopOpenResult } from "./open-session.ts";
import { listDesktopSessions, type DesktopSession } from "./desktop-sessions.ts";
import { LIBRARY_SIZE, type OpenResult, type SessionHost } from "./host.ts";
import type { SessionHub } from "./hub.ts";
import type { AgentEntry } from "./state.ts";
import { claudeAgents } from "./workspace-sessions.ts";

/** Replaceable so tests don't open real sessions or read the real desktop app. */
export interface DesktopDeps {
  list?: () => Promise<AgentEntry[]>;
  desktopSessions?: () => Promise<DesktopSession[]>;
  open?: (sessionId: string, cwd?: string) => Promise<DesktopOpenResult>;
  watch?: (onFocus: (sessionId: string | null) => void) => () => void;
  /** Brings forward a session that runs in a terminal; without it, the strip is told to go to its terminal. */
  inTerminal?: (sessionId: string) => Promise<OpenResult>;
}

export function desktopHost(
  hub: SessionHub,
  { list = claudeAgents, desktopSessions = () => listDesktopSessions(), open = openSession, watch = watchDesktopFocus, inTerminal }: DesktopDeps = {},
): SessionHost {
  return {
    id: "desktop",
    reopensUnderNewId: false,
    sessions: list,

    async open(sessionId) {
      const result = await open(sessionId, hub.get(sessionId)?.cwd);
      // The desktop log confirms focus a moment later; the caller shows it right away.
      if (result.ok) return { focused: true };
      if (result.inTerminal && inTerminal) return inTerminal(sessionId);
      return { focused: false, message: result.error };
    },

    followFocus: () => watch((id) => hub.setFocused(id)),

    async library(): Promise<LibraryEntry[]> {
      return (await desktopSessions())
        .filter((s) => !s.archived)
        .slice(0, LIBRARY_SIZE)
        .map((s) => ({
          id: s.sessionId,
          name: s.title ?? hub.get(s.sessionId)?.name ?? basename(s.cwd),
          cwd: s.cwd,
          lastActivityAt: s.lastActivityAt,
          pinned: hub.get(s.sessionId)?.pinned ?? false,
        }));
    },

    async adopt(sessionId) {
      const session = (await desktopSessions()).find((s) => s.sessionId === sessionId);
      if (session) hub.adopt(session.sessionId, session.title, session.cwd, session.lastActivityAt);
    },
  };
}
