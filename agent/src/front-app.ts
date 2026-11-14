import type { FrontApp as Reported } from "../../shared/protocol.ts";

/** "unknown" until an overlay reports, so an agent without one behaves as it always did. */
export type FrontState = Reported | "unknown";

/** The app in front as the overlay last reported it. */
export class FrontApp {
  private current: FrontState = "unknown";
  private listeners = new Set<(app: FrontState) => void>();

  get value(): FrontState {
    return this.current;
  }

  set(app: FrontState) {
    if (app === this.current) return;
    this.current = app;
    for (const listener of this.listeners) listener(app);
  }

  subscribe(listener: (app: FrontState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether to ask Terminal which tab is selected: it is in front, or nothing says otherwise. */
  terminalMayRun() {
    return this.current === "terminal" || this.current === "unknown";
  }
}
