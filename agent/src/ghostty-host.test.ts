import { expect, test } from "bun:test";
import { ghosttyHost } from "./ghostty-host.ts";
import { parseProcessTable } from "./ghostty.ts";
import { SessionHub } from "./hub.ts";
import type { AgentEntry } from "./state.ts";
import { Store } from "./store.ts";

const COMPOSER = "22222222-2222-4222-8222-222222222222";
const API_DEV = "33333333-3333-4333-8333-333333333333";
const CLOSED = "44444444-4444-4444-8444-444444444444";

// Ghostty → login → zsh → nvim on ttys005 → zsh → claude (704) on nvim's ttys009.
const table = parseProcessTable(`
    1     0 ??
  500     1 ??
  700   500 ttys005
  701   700 ttys005
  702   701 ttys005
  703   702 ttys009
  704   703 ttys009
`);

function setup({ panelFound = true, focus }: { panelFound?: boolean; focus?: (ttys: string[]) => Promise<boolean> } = {}) {
  const live: AgentEntry[] = [
    { sessionId: COMPOSER, name: "composer", cwd: "/Users/dev/work", pid: 704, status: "idle", startedAt: 0 },
    { sessionId: API_DEV, name: "api-dev", cwd: "/Users/dev/work/api", pid: 4343, status: "busy", startedAt: 0 },
  ];
  let now = 1000;
  const hub = new SessionHub(new Store(), () => now++);
  const asked: string[][] = [];
  const watching: string[] = [];
  const host = ghosttyHost(hub, {
    list: async () => live,
    table: async () => table,
    focus: focus ?? (async (ttys) => (asked.push(ttys), panelFound)),
    watch: () => {
      watching.push("started");
      return () => watching.push("stopped");
    },
  });
  return { hub, host, live, asked, watching };
}

test("it is the ghostty host, where a reopened session comes back under a new id", () => {
  const { host } = setup();
  expect(host.id).toBe("ghostty");
  expect(host.reopensUnderNewId).toBe(true);
});

test("tracks the sessions its lister gives", async () => {
  const { host, live } = setup();
  expect(await host.sessions()).toEqual(live);
});

test("opening a running session focuses the panel on its tty chain", async () => {
  const { hub, host, live, asked } = setup();
  hub.handleAgents(live);
  expect(await host.open(COMPOSER)).toEqual({ focused: true });
  expect(asked).toEqual([["/dev/ttys009", "/dev/ttys005"]]);
});

test("without a panel for the session it only shows Ghostty, and says why", async () => {
  const { hub, host, live, asked } = setup({ panelFound: false });
  hub.handleAgents(live);
  expect(await host.open(API_DEV)).toEqual({ focused: false, message: "no Ghostty panel found; showed Ghostty" });

  hub.handleHook({ hook_event_name: "SessionEnd", session_id: CLOSED, cwd: "/Users/dev/work" });
  expect(await host.open(CLOSED)).toEqual({ focused: false, message: "not running; showed Ghostty" });
  expect(asked.at(-1)).toEqual([]);
});

test("an AppleScript failure is reported, not thrown", async () => {
  const { hub, host, live } = setup({
    focus: async () => {
      throw new Error("Not authorized to send Apple events to Ghostty. (-1743)");
    },
  });
  hub.handleAgents(live);
  expect(await host.open(COMPOSER)).toEqual({ focused: false, message: "Ghostty: Not authorized to send Apple events to Ghostty. (-1743)" });
});

test("the library lists the running sessions, known to the hub so any can be pinned", async () => {
  const { hub, host } = setup();
  const entries = await host.library();
  expect(entries.map((e) => [e.name, e.pinned])).toEqual([
    ["composer", false],
    ["api-dev", false],
  ]);
  expect(hub.setPinned(API_DEV, true)).toBe(true);
  expect((await host.library()).find((e) => e.id === API_DEV)!.pinned).toBe(true);
});

test("following focus starts the Ghostty watcher and returns its stop", () => {
  const { host, watching } = setup();
  const stop = host.followFocus();
  expect(watching).toEqual(["started"]);
  stop();
  expect(watching).toEqual(["started", "stopped"]);
});
