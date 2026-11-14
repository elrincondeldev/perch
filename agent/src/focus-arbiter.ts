import type { FrontApp } from "./front-app.ts";

/**
 * Decides when the desktop app's log may move the focus. Terminal focus needs no gate of its own: its
 * watcher only asks while Terminal is in front. The log is always followed and remembered, but:
 * - with Terminal or another app in front the focus stays where it is;
 * - once the desktop app is in front its latest focus is applied, and so is each new one;
 * - with no overlay reporting ("unknown") the log applies directly, as it did before the overlay told the agent anything.
 */
export class FocusArbiter {
  private latest: string | null = null;

  constructor(
    private front: FrontApp,
    private apply: (sessionId: string | null) => void,
  ) {
    front.subscribe((app) => {
      if (app === "desktop" && this.latest) this.apply(this.latest);
    });
  }

  /** The session in front in the desktop app, from its log. */
  desktop(sessionId: string | null) {
    this.latest = sessionId;
    const app = this.front.value;
    if (app === "desktop" || app === "unknown") this.apply(sessionId);
  }
}
