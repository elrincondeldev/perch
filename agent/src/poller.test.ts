import { expect, test } from "bun:test";
import { SessionHub } from "./hub.ts";
import { startPoller } from "./poller.ts";
import { Store } from "./store.ts";

const A = "0603472f-b7c5-4dae-b7a1-142468264b30";

test("a dead process ends its session even when `claude agents` fails", async () => {
  const hub = new SessionHub(new Store());
  hub.handleHook({ session_id: A, hook_event_name: "UserPromptSubmit", cwd: "/x" });
  const errors = console.error;
  console.error = () => {};
  const stop = startPoller(hub, {
    intervalMs: 5,
    agents: async () => {
      throw new Error("claude: command not found");
    },
    sessionPids: async () => new Map([[A, 4242]]),
    isAlive: () => false,
  });
  await Bun.sleep(50);
  stop();
  console.error = errors;
  expect(hub.get(A)).toMatchObject({ state: "ended", live: false });
});
