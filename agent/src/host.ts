/**
 * A session host is where Claude Code sessions run and are brought to the front: the Claude
 * desktop app, or a terminal. Everything that differs between them sits behind SessionHost, so
 * another terminal is one more implementation of it (see ghostty-host.ts), an id in
 * SESSION_HOSTS (shared/protocol.ts, mirrored in Sources/TomariCore/Protocol.swift) and an
 * entry in the map agent.ts gives to HostSwitch.
 */
import { SESSION_HOSTS, type LibraryEntry, type ServerMessage, type SessionHostId } from "../../shared/protocol.ts";
import type { AgentEntry } from "./state.ts";

/** When the session couldn't be brought to the front, `message` tells the strip why. */
export type OpenResult = { focused: true } | { focused: false; message: string };

export interface SessionHost {
  readonly id: SessionHostId;
  /**
   * True when reopening a session gives it a new id, so its name is what identifies it: the
   * closed record under the same name is then dropped. False when a session keeps its id.
   */
  readonly reopensUnderNewId: boolean;
  /** The running sessions to track; polled every few seconds. */
  sessions(): Promise<AgentEntry[]>;
  /** Brings a session the hub knows to the front. */
  open(sessionId: string): Promise<OpenResult>;
  /** Keeps the hub's focused session on the one in front, until the returned function is called. */
  followFocus(): () => void;
  /** What the + menu offers to pin, most recent first. */
  library(): Promise<LibraryEntry[]>;
  /** Makes a session from the library known to the hub when it isn't yet, so it can be pinned. */
  adopt(sessionId: string): Promise<void>;
}

export const LIBRARY_SIZE = 100;

/** A host id, from config.json or as typed: `app` is the Claude desktop app. Null when it names none. */
export function parseHost(value: unknown): SessionHostId | null {
  if (value === "app") return "desktop";
  return SESSION_HOSTS.find((id) => id === value) ?? null;
}

interface HostAwareHub {
  setFocused(id: string | null): void;
  replaceSameNames(on: boolean): void;
}

/** The host in use. Switching needs no restart: the old focus watcher stops and the new host's starts. */
export class HostSwitch {
  private active: SessionHost;
  private stopFocus: () => void;
  private listeners = new Set<(id: SessionHostId) => void>();

  constructor(
    private hosts: Record<SessionHostId, SessionHost>,
    initial: SessionHostId,
    private hub: HostAwareHub,
    private save: (id: SessionHostId) => Promise<void>,
  ) {
    this.active = hosts[initial];
    this.stopFocus = this.start();
  }

  get current(): SessionHost {
    return this.active;
  }

  subscribe(listener: (id: SessionHostId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Switches to `id` and saves the choice. False when it was already in use. */
  async use(id: SessionHostId): Promise<boolean> {
    if (id === this.active.id) return false;
    this.stopFocus();
    this.active = this.hosts[id];
    this.hub.setFocused(null);
    this.stopFocus = this.start();
    for (const listener of this.listeners) listener(id);
    await this.save(id);
    return true;
  }

  stop() {
    this.stopFocus();
  }

  private start() {
    this.hub.replaceSameNames(this.active.reopensUnderNewId);
    return this.active.followFocus();
  }
}

/**
 * Asks a running agent, over its panel socket at `url`, to switch host; the agent saves the
 * choice itself. False when no agent confirms in time.
 */
export function askAgentToUse(host: SessionHostId, url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const finish = (confirmed: boolean) => {
      clearTimeout(timer);
      ws.close();
      resolve(confirmed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: "host", host }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.type === "host") finish(msg.host === host);
      else if (msg.type === "error") finish(false);
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}
