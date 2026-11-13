/**
 * Two servers: hooks on loopback only, and the panel WebSocket behind the pairing token,
 * on loopback unless a Pi needs it on the network. Keeping them apart means the
 * network-facing port can never inject hook events.
 */
import { timingSafeEqual } from "node:crypto";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { HostSwitch } from "./host.ts";
import type { SessionHub } from "./hub.ts";
import { parseClientMessage } from "./protocol-guard.ts";
import type { HookEvent } from "./state.ts";

export interface ServerOptions {
  hub: SessionHub;
  /** Opening a session and listing the ones to pin go to the host in use. */
  hosts: HostSwitch;
  token: string;
  hookPort: number;
  panelPort: number;
  panelHost?: string;
}

const TOPIC = "panel";

export function startServers({ hub, hosts, token, hookPort, panelPort, panelHost = "127.0.0.1" }: ServerOptions) {
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

  const panelServer = Bun.serve({
    hostname: panelHost,
    port: panelPort,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, sessions: hub.snapshot().length, host: hosts.current.id });
      if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
      if (!sameSecret(url.searchParams.get("token"), token)) return new Response("unauthorized", { status: 401 });
      if (server.upgrade(req)) return;
      return new Response("expected a WebSocket", { status: 400 });
    },
    websocket: {
      maxPayloadLength: 4 * 1024,
      open(ws) {
        ws.subscribe(TOPIC);
        send(ws, { type: "snapshot", sessions: hub.snapshot(), focusedId: hub.focusedId, host: hosts.current.id });
      },
      async message(ws, raw) {
        const msg = parseClientMessage(String(raw));
        if (!msg) return send(ws, { type: "error", message: "invalid message" });
        try {
          if (msg.type === "library") return send(ws, { type: "library", sessions: await hosts.current.library() });
        } catch (err) {
          return send(ws, { type: "error", message: `could not list sessions: ${text(err)}`.slice(0, 200) });
        }
        if (msg.type === "host") {
          try {
            // A change reaches every panel through the subscription below; this confirms a choice that changed nothing.
            if (!(await hosts.use(msg.host))) send(ws, { type: "host", host: msg.host });
          } catch (err) {
            send(ws, { type: "error", message: `could not save the host: ${text(err)}`.slice(0, 200) });
          }
          return;
        }
        // Lets the panel pin a session the agent never saw, e.g. a desktop session whose process isn't running.
        if (!hub.has(msg.id) && msg.type !== "open") await hosts.current.adopt(msg.id);
        if (!hub.has(msg.id)) return send(ws, { type: "error", message: "unknown session" });

        switch (msg.type) {
          case "open": {
            const result = await hosts.current.open(msg.id);
            // The host's focus watcher confirms a moment later; show it right away.
            if (result.focused) hub.setFocused(msg.id);
            else send(ws, { type: "error", message: result.message });
            break;
          }
          case "pin":
            hub.setPinned(msg.id, msg.pinned);
            break;
          case "icon":
            hub.setIcon(msg.id, msg.icon);
            break;
        }
      },
      close(ws) {
        ws.unsubscribe(TOPIC);
      },
    },
  });

  const publish = (message: ServerMessage) => void panelServer.publish(TOPIC, JSON.stringify(message));
  const unsubscribeHub = hub.subscribe(publish);
  const unsubscribeHosts = hosts.subscribe((host) => publish({ type: "host", host }));

  return {
    hookServer,
    panelServer,
    stop() {
      unsubscribeHub();
      unsubscribeHosts();
      hookServer.stop(true);
      panelServer.stop(true);
    },
  };
}

function send(ws: { send(data: string): unknown }, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}

function text(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Constant-time, so response timing doesn't leak the token. */
function sameSecret(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
