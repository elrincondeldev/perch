import { afterEach, beforeEach, expect, test } from "bun:test";
import type { LibraryEntry, ServerMessage, SessionHostId } from "../../shared/protocol.ts";
import { askAgentToUse, HostSwitch, type OpenResult, type SessionHost } from "./host.ts";
import { SessionHub } from "./hub.ts";
import { startServers } from "./server.ts";
import { Store } from "./store.ts";

const ID = "0603472f-b7c5-4dae-b7a1-142468264b30";
const IDLE = "22222222-2222-4222-8222-222222222222";
const TOKEN = "test-token";

let servers: ReturnType<typeof startServers>;
let hub: SessionHub;
let hosts: HostSwitch;
/** What the fake hosts were asked, as "host: request". */
let asked: string[];
let saved: SessionHostId[];
let openResult: OpenResult;
let libraryFails: boolean;

/** A host that records what it is asked; its library offers one session that isn't running, which it can adopt. */
function fakeHost(id: SessionHostId): SessionHost {
  const entry = (): LibraryEntry => ({ id: IDLE, name: `${id} session`, cwd: "/Users/dev/idle", lastActivityAt: 5000, pinned: hub.get(IDLE)?.pinned ?? false });
  return {
    id,
    reopensUnderNewId: id === "ghostty",
    sessions: async () => [],
    open: async (sessionId) => {
      asked.push(`${id}: open ${sessionId}`);
      return openResult;
    },
    followFocus: () => {
      asked.push(`${id}: follow focus`);
      return () => asked.push(`${id}: stop following`);
    },
    library: async () => {
      if (libraryFails) throw new Error("claude: command not found");
      return [entry()];
    },
    adopt: async (sessionId) => {
      asked.push(`${id}: adopt ${sessionId}`);
      if (sessionId === IDLE) hub.adopt(IDLE, `${id} session`, "/Users/dev/idle", 5000);
    },
  };
}

beforeEach(() => {
  asked = [];
  saved = [];
  openResult = { focused: true };
  libraryFails = false;
  hub = new SessionHub(new Store(), Date.now, false);
  hosts = new HostSwitch({ desktop: fakeHost("desktop"), ghostty: fakeHost("ghostty") }, "ghostty", hub, async (id) => void saved.push(id));
  servers = startServers({ hub, hosts, token: TOKEN, hookPort: 0, panelPort: 0, panelHost: "127.0.0.1" }); // 0 = any free port
});
afterEach(() => {
  servers.stop();
  hosts.stop();
});

const hookUrl = () => `http://127.0.0.1:${servers.hookServer.port}/hook`;
const panelHttp = () => `http://127.0.0.1:${servers.panelServer.port}`;
const panelWs = (token = TOKEN) => `ws://127.0.0.1:${servers.panelServer.port}/ws?token=${token}`;

function postHook(event: Record<string, unknown>, url = hookUrl()) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
}

/** Opens a panel connection; next() resolves with the following server message. */
async function connect() {
  const ws = new WebSocket(panelWs());
  const inbox: ServerMessage[] = [];
  const waiting: ((m: ServerMessage) => void)[] = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as ServerMessage;
    const resolve = waiting.shift();
    if (resolve) resolve(msg);
    else inbox.push(msg);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const next = () =>
    inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<ServerMessage>((resolve) => waiting.push(resolve));
  return { ws, next };
}

test("a wrong token is rejected", async () => {
  expect((await fetch(`${panelHttp()}/ws?token=nope`)).status).toBe(401);
  expect((await fetch(`${panelHttp()}/ws`)).status).toBe(401);
});

test("the network-facing port does not accept hook events", async () => {
  const res = await postHook({ hook_event_name: "Stop", session_id: ID, cwd: "/tmp" }, `${panelHttp()}/hook`);
  expect(res.status).toBe(404);
});

test("the panel gets a snapshot with the host in use, then live updates from hooks", async () => {
  const { ws, next } = await connect();
  expect(await next()).toEqual({ type: "snapshot", sessions: [], focusedId: null, host: "ghostty" });

  const res = await postHook({ hook_event_name: "UserPromptSubmit", session_id: ID, cwd: "/tmp/demo" });
  expect(res.status).toBe(204);
  expect(await next()).toMatchObject({ type: "session", session: { id: ID, name: "demo", state: "working", live: true } });
  ws.close();
});

test("pin and icon commands; anything else is refused", async () => {
  await postHook({ hook_event_name: "Stop", session_id: ID, cwd: "/tmp/demo" });
  const { ws, next } = await connect();
  await next(); // snapshot

  ws.send(JSON.stringify({ type: "pin", id: ID, pinned: true }));
  expect(await next()).toMatchObject({ type: "session", session: { id: ID, pinned: true, position: 0 } });

  ws.send(JSON.stringify({ type: "pin", id: ID, pinned: false }));
  expect(await next()).toMatchObject({ type: "session", session: { pinned: false } });

  ws.send(JSON.stringify({ type: "icon", id: ID, icon: { character: "crab", color: "#ff6a1a" } }));
  expect(await next()).toMatchObject({ type: "session", session: { pinned: true, icon: { character: "crab" } } });

  ws.send(JSON.stringify({ type: "open", id: "11111111-1111-1111-1111-111111111111" }));
  expect(await next()).toEqual({ type: "error", message: "unknown session" });

  ws.send("rm -rf /");
  expect(await next()).toEqual({ type: "error", message: "invalid message" });
  ws.close();
});

test("open asks the host in use: focus is shown at once, and a session it couldn't bring forward is explained", async () => {
  await postHook({ hook_event_name: "Stop", session_id: ID, cwd: "/tmp/demo" });
  const { ws, next } = await connect();
  await next(); // snapshot

  ws.send(JSON.stringify({ type: "open", id: ID }));
  expect(await next()).toEqual({ type: "focus", id: ID });
  expect(asked).toContain(`ghostty: open ${ID}`);

  openResult = { focused: false, message: "not running; showed Ghostty" };
  ws.send(JSON.stringify({ type: "open", id: ID }));
  expect(await next()).toEqual({ type: "error", message: "not running; showed Ghostty" });
  ws.close();
});

test("the library comes from the host in use, and pinning a session the agent never saw adopts it first", async () => {
  const { ws, next } = await connect();
  await next(); // snapshot

  ws.send(JSON.stringify({ type: "library" }));
  expect(await next()).toEqual({
    type: "library",
    sessions: [{ id: IDLE, name: "ghostty session", cwd: "/Users/dev/idle", lastActivityAt: 5000, pinned: false }],
  });

  ws.send(JSON.stringify({ type: "pin", id: IDLE, pinned: true }));
  expect(await next()).toMatchObject({ type: "session", session: { id: IDLE, live: false, state: "ended" } });
  expect(await next()).toMatchObject({ type: "session", session: { id: IDLE, pinned: true } });
  expect(asked).toContain(`ghostty: adopt ${IDLE}`);

  ws.send(JSON.stringify({ type: "library" }));
  expect(await next()).toMatchObject({ type: "library", sessions: [{ id: IDLE, pinned: true }] });
  ws.close();
});

test("opening never adopts: an unknown session stays unknown", async () => {
  const { ws, next } = await connect();
  await next(); // snapshot
  ws.send(JSON.stringify({ type: "open", id: IDLE }));
  expect(await next()).toEqual({ type: "error", message: "unknown session" });
  expect(asked.filter((a) => a.includes("adopt"))).toEqual([]);
  ws.close();
});

test("a host that can't list its sessions is reported to the strip", async () => {
  libraryFails = true;
  const { ws, next } = await connect();
  await next(); // snapshot
  ws.send(JSON.stringify({ type: "library" }));
  expect(await next()).toEqual({ type: "error", message: "could not list sessions: claude: command not found" });
  ws.close();
});

test("a host message switches the adapter without a restart, and every panel hears it", async () => {
  await postHook({ hook_event_name: "Stop", session_id: ID, cwd: "/tmp/demo" });
  const menu = await connect();
  const other = await connect();
  await menu.next(); // snapshot
  await other.next();

  menu.ws.send(JSON.stringify({ type: "host", host: "desktop" }));
  expect(await menu.next()).toEqual({ type: "host", host: "desktop" });
  expect(await other.next()).toEqual({ type: "host", host: "desktop" });
  expect(asked).toEqual(["ghostty: follow focus", "ghostty: stop following", "desktop: follow focus"]);
  expect(saved).toEqual(["desktop"]);

  menu.ws.send(JSON.stringify({ type: "open", id: ID }));
  expect(await menu.next()).toEqual({ type: "focus", id: ID });
  expect(asked.at(-1)).toBe(`desktop: open ${ID}`);

  menu.ws.send(JSON.stringify({ type: "library" }));
  expect(await menu.next()).toMatchObject({ type: "library", sessions: [{ name: "desktop session" }] });

  const late = await connect();
  expect(await late.next()).toMatchObject({ type: "snapshot", host: "desktop" });
  for (const { ws } of [menu, other, late]) ws.close();
});

test("choosing the host already in use is confirmed to the asker only, and nothing restarts", async () => {
  const { ws, next } = await connect();
  await next(); // snapshot
  ws.send(JSON.stringify({ type: "host", host: "ghostty" }));
  expect(await next()).toEqual({ type: "host", host: "ghostty" });
  expect(asked).toEqual(["ghostty: follow focus"]);
  expect(saved).toEqual([]);
  ws.close();
});

test("the CLI switches a running agent's host over the panel socket", async () => {
  expect(await askAgentToUse("desktop", panelWs())).toBe(true);
  expect(hosts.current.id).toBe("desktop");
  expect(saved).toEqual(["desktop"]);
});

test("the CLI learns when no agent answers, or the token is wrong", async () => {
  expect(await askAgentToUse("desktop", panelWs("nope"))).toBe(false);
  expect(await askAgentToUse("desktop", "ws://127.0.0.1:1/ws?token=x")).toBe(false);
  expect(hosts.current.id).toBe("ghostty");
});
