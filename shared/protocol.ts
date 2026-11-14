/**
 * Contract between the agent and the Tomari overlay (mirrored in Sources/TomariCore/Protocol.swift),
 * over a WebSocket at ws://127.0.0.1:PANEL_PORT/ws?token=<pairing token>.
 * The agent sends a snapshot on connect, then one message per change. The overlay shows pinned
 * sessions and those working or waiting on the user.
 */

export const PANEL_PORT = 7778;

export const SESSION_STATES = [
  "idle", // started, no prompt yet
  "working",
  "needs_permission",
  "needs_input", // a question, a plan to review, or otherwise waiting on the user
  "compacting",
  "done", // finished its turn: the user's move
  "error",
  "ended", // process gone
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export interface SessionIcon {
  /** Sprite sheet id. */
  character: string;
  /** "#rrggbb" */
  color: string;
}

export const DEFAULT_ICON: SessionIcon = { character: "default", color: "#d97757" };

/** What `claude agents` says a session is. Clients must treat other values as unknown. */
export type SessionKind = "interactive" | "background" | (string & {});

/** The Claude daemon's own sessions (`--bg`, `claude agents`): no terminal tty to focus. */
export const BACKGROUND_KIND = "background" satisfies SessionKind;

export interface PanelSession {
  id: string;
  name: string;
  cwd: string;
  state: SessionState;
  /** Short detail for the tile, e.g. "Bash: npm test". */
  activity: string | null;
  /** The Claude process is running. */
  live: boolean;
  /** Epoch ms of the last state change. */
  stateSince: number;
  pinned: boolean;
  /** Order among pinned sessions; null when not pinned. */
  position: number | null;
  icon: SessionIcon;
  /**
   * From `claude agents`: "interactive" (a terminal) or "background" (`--bg`, run by the Claude daemon).
   * Absent until the poll has seen the session. Clients must treat other values as unknown.
   */
  kind?: SessionKind;
  /**
   * Background sessions only: whether a Terminal tab shows the session, so opening it focuses that tab
   * instead of attaching a new one. Absent for other sessions; clients must treat absence as unknown.
   */
  inTab?: boolean;
}

/** A desktop-app session the panel can pin, running or not. */
export interface LibraryEntry {
  id: string;
  name: string;
  cwd: string;
  /** Epoch ms of its last activity. */
  lastActivityAt: number;
  pinned: boolean;
}

export type ServerMessage =
  | { type: "snapshot"; sessions: PanelSession[]; focusedId: string | null }
  | { type: "session"; session: PanelSession }
  | { type: "removed"; id: string }
  | { type: "focus"; id: string | null } // the session in front in the desktop app; null when none
  | { type: "library"; sessions: LibraryEntry[] } // reply to a library request, most recent first
  | { type: "error"; message: string };

/** What the overlay says is in front: Terminal.app, the Claude desktop app, or anything else. */
export const FRONT_APPS = ["terminal", "desktop", "other"] as const;
export type FrontApp = (typeof FRONT_APPS)[number];

/** `pin` and `icon` also accept a desktop session that isn't running: the agent starts tracking it. */
export type ClientMessage =
  | { type: "open"; id: string }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "stop"; id: string } // stops a live background session; its conversation is kept
  | { type: "icon"; id: string; icon: SessionIcon } // pins the session if it isn't yet
  | { type: "library" }
  | { type: "terminal" } // opens a shell in a new Terminal.app tab, without Claude
  | { type: "frontApp"; app: FrontApp }; // sent on connect and when the app in front changes, so the agent asks Terminal only while it is in front
