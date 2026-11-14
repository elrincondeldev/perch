/**
 * Two servers: hooks on loopback only, and the panel WebSocket behind the pairing token,
 * on loopback unless a Pi needs it on the network. Keeping them apart means the
 * network-facing port can never inject hook events.
 */
import { timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { BACKGROUND_KIND, type LibraryEntry, type ServerMessage } from "../../shared/protocol.ts";
import { desktopSessionsLister, type DesktopSession } from "./desktop-sessions.ts";
import type { SessionHub } from "./hub.ts";
import { openSession, openTerminalTab, type OpenOptions, type OpenResult } from "./open-session.ts";
import { parseClientMessage } from "./protocol-guard.ts";
import { stopSession } from "./stop-session.ts";
import type { HookEvent } from "./state.ts";
import { FrontApp } from "./front-app.ts";

export interface ServerOptions {
  hub: SessionHub;
  /** Where clients' reports of the app in front are kept. */
  front?: FrontApp;
  token: string;
  hookPort: number;
  panelPort: number;
  panelHost?: string;
  /** Replaceable so tests don't open real sessions or tabs, or read the real desktop app. */
  open?: (id: string, options?: OpenOptions) => Promise<OpenResult>;
  terminal?: () => Promise<OpenResult>;
  stop?: (id: string) => Promise<OpenResult>;
  desktopSessions?: () => Promise<DesktopSession[]>;
  /** Whether a panel client connects from this Mac; with `--pi` others can reach the port. Replaceable for tests. */
  isLocal?: (address: string | undefined) => boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Only a client on this Mac may stop sessions or see a command's error output. */
function loopback(address: string | undefined) {
  return address !== undefined && LOOPBACK.has(address);
}

const TOPIC = "panel";
const LIBRARY_SIZE = 100;

export function startServers({
  hub,
  front = new FrontApp(),
  token,
  hookPort,
  panelPort,
  panelHost = "127.0.0.1",
  open = openSession,
  terminal = openTerminalTab,
  stop = stopSession,
  desktopSessions = desktopSessionsLister(),
  isLocal = loopback,
}: ServerOptions) {
  /** Desktop sessions plus the live ones the agent sees, e.g. in a terminal; a desktop entry wins a duplicate. */
  async function library(): Promise<LibraryEntry[]> {
    const desktop = await desktopSessions();
    const inDesktop = new Set(desktop.map((s) => s.sessionId));
    const entries: LibraryEntry[] = desktop
      .filter((s) => !s.archived)
      .map((s) => ({
        id: s.sessionId,
        name: s.title ?? hub.get(s.sessionId)?.name ?? basename(s.cwd),
        cwd: s.cwd,
        lastActivityAt: s.lastActivityAt,
        pinned: hub.get(s.sessionId)?.pinned ?? false,
      }));
    for (const entry of hub.liveEntries()) if (!inDesktop.has(entry.id)) entries.push(entry);
    return entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, LIBRARY_SIZE);
  }

  /** Lets the panel pin a desktop session whose process isn't running, so the agent never saw it. */
  async function adoptFromDesktop(id: string) {
    const session = (await desktopSessions()).find((s) => s.sessionId === id);
    if (session) hub.adopt(session.sessionId, session.title, session.cwd, session.lastActivityAt);
  }

  /** Sessions with a stop under way: a second request meanwhile would run `claude stop` twice. */
  const stopping = new Set<string>();

  const hookServer = Bun.serve({
    hostname: "127.0.0.1",
    port: hookPort,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "POST" || pathname !== "/hook") return new Response("not found", { status: 404 });
      try {
        const event = (await req.json()) as HookEvent;
        if (typeof event?.session_id === "string" && typeof event.hook_event_name === "string") hub.handleHook(event);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      return new Response(null, { status: 204 }); // an empty 2xx tells Claude Code "no decision"
    },
  });

  /** A command's error output can hold local paths: only a client on this Mac gets it; others see a generic line. */
  function failed(ws: { data: { local: boolean }; send(data: string): unknown }, error: string) {
    if (ws.data.local) return send(ws, { type: "error", message: error });
    console.error(`panel command failed: ${error}`);
    send(ws, { type: "error", message: "the command failed on the Mac" });
  }

  const panelServer = Bun.serve<{ local: boolean; reportedFront: boolean }>({
    hostname: panelHost,
    port: panelPort,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, sessions: hub.snapshot().length });
      if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
      if (!sameSecret(url.searchParams.get("token"), token)) return new Response("unauthorized", { status: 401 });
      if (server.upgrade(req, { data: { local: isLocal(server.requestIP(req)?.address), reportedFront: false } })) return;
      return new Response("expected a WebSocket", { status: 400 });
    },
    websocket: {
      maxPayloadLength: 4 * 1024,
      open(ws) {
        ws.subscribe(TOPIC);
        send(ws, { type: "snapshot", sessions: hub.snapshot(), focusedId: hub.focusedId });
      },
      async message(ws, raw) {
        // An async handler's rejection is unhandled and kills the agent: answer it instead.
        try {
          const msg = parseClientMessage(String(raw));
          if (!msg) return send(ws, { type: "error", message: "invalid message" });
          if (msg.type === "library") return send(ws, { type: "library", sessions: await library() });
          if (msg.type === "frontApp") {
            ws.data.reportedFront = true;
            front.set(msg.app);
            return;
          }
          if (msg.type === "terminal") {
            const result = await terminal();
            if (!result.ok) failed(ws, result.error);
            return;
          }
          if (!hub.has(msg.id) && msg.type !== "open" && msg.type !== "stop") await adoptFromDesktop(msg.id);
          if (!hub.has(msg.id)) return send(ws, { type: "error", message: "unknown session" });

          switch (msg.type) {
            case "open": {
              const session = hub.get(msg.id);
              const result = await open(msg.id, { cwd: session?.cwd, kind: session?.kind, name: hub.titleOf(msg.id) ?? undefined });
              // The desktop log confirms focus a moment later; show it right away.
              if (result.ok) hub.setFocused(msg.id);
              else failed(ws, result.error);
              break;
            }
            case "stop": {
              if (!ws.data.local) return send(ws, { type: "error", message: "stop only works from this Mac" });
              const session = hub.get(msg.id);
              if (!session?.live || session.kind !== BACKGROUND_KIND) {
                return send(ws, { type: "error", message: "not a running background session" });
              }
              if (stopping.has(msg.id)) return send(ws, { type: "error", message: "already stopping" });
              stopping.add(msg.id);
              try {
                const result = await stop(msg.id);
                if (result.ok) hub.endSession(msg.id);
                else failed(ws, result.error);
              } finally {
                stopping.delete(msg.id);
              }
              break;
            }
            case "pin":
              hub.setPinned(msg.id, msg.pinned);
              break;
            case "icon":
              hub.setIcon(msg.id, msg.icon);
              break;
          }
        } catch (error) {
          console.error(`panel message failed: ${error instanceof Error ? error.message : String(error)}`);
          send(ws, { type: "error", message: "internal error" }); // details stay in the log, off the network port
        }
      },
      close(ws) {
        ws.unsubscribe(TOPIC);
        if (ws.data.reportedFront) front.set("unknown"); // its report is stale now; ask Terminal again until someone says
      },
    },
  });

  const unsubscribe = hub.subscribe((change) => panelServer.publish(TOPIC, JSON.stringify(change satisfies ServerMessage)));

  return {
    hookServer,
    panelServer,
    stop() {
      unsubscribe();
      hookServer.stop(true);
      panelServer.stop(true);
    },
  };
}

function send(ws: { send(data: string): unknown }, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}

/** Constant-time, so response timing doesn't leak the token. */
function sameSecret(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
