/**
 * Keeps the hub's focused session on the one in front in Ghostty: the focused panel of the
 * selected tab of the front window, matched to a session by tty. While a panel is in front it
 * re-checks every few seconds, so a session started in it is picked up without a focus change.
 */
import { processTable, sessionOnTty, watchFocusedTty, type ProcessTable } from "./ghostty.ts";
import type { SessionHub } from "./hub.ts";

export interface FocusDeps {
  watch?: (onTty: (tty: string | null) => void) => () => void;
  table?: () => Promise<ProcessTable>;
  recheckMs?: number;
}

export function followGhosttyFocus(
  hub: Pick<SessionHub, "setFocused" | "processes">,
  { watch = watchFocusedTty, table = processTable, recheckMs = 5000 }: FocusDeps = {},
) {
  let tty: string | null = null;

  async function resolve() {
    const asked = tty;
    try {
      const id = asked === null ? null : sessionOnTty(asked, hub.processes(), await table());
      if (asked === tty) hub.setFocused(id); // a newer focus change may have answered already
    } catch (error) {
      console.error(`focus lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const stopWatching = watch((next) => {
    tty = next;
    void resolve();
  });
  const timer = setInterval(() => tty !== null && void resolve(), recheckMs);

  return () => {
    clearInterval(timer);
    stopWatching();
  };
}
