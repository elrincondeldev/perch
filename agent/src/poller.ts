import { $ } from "bun";
import type { SessionHub } from "./hub.ts";
import { isAlive, sessionPids } from "./open-session.ts";
import type { AgentEntry } from "./state.ts";

export interface PollerOptions {
  intervalMs?: number;
  /** Replaceable so tests don't run the real CLI or read ~/.claude/sessions. */
  agents?: () => Promise<AgentEntry[]>;
  sessionPids?: () => Promise<Map<string, number>>;
  isAlive?: (pid: number) => boolean;
}

/** Feeds `claude agents --json` to the hub every `intervalMs`. Returns a stop function. */
export function startPoller(
  hub: SessionHub,
  {
    intervalMs = 3000,
    agents = () => $`claude agents --json`.quiet().json(),
    sessionPids: pids = () => sessionPids(),
    isAlive: alive = isAlive,
  }: PollerOptions = {},
) {
  let stopped = false;
  let lastError = "";

  (async () => {
    while (!stopped) {
      try {
        hub.handleAgents(await agents());
        lastError = "";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== lastError) console.error(`poll failed: ${message}`); // log each distinct failure once
        lastError = message;
      }
      // Independent of the command: it may be failing, or a closed tab never said SessionEnd.
      try {
        hub.endDead(alive, await pids());
      } catch (err) {
        console.error(`liveness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await Bun.sleep(intervalMs);
    }
  })();

  return () => {
    stopped = true;
  };
}
