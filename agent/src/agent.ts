import { BACKGROUND_KIND, PANEL_PORT } from "../../shared/protocol.ts";
import { HOOK_PORT, loadConfig } from "./config.ts";
import { watchDesktopFocus } from "./desktop-focus.ts";
import { FocusArbiter } from "./focus-arbiter.ts";
import { FrontApp } from "./front-app.ts";
import { SessionHub } from "./hub.ts";
import { startPoller } from "./poller.ts";
import { startServers } from "./server.ts";
import { Store } from "./store.ts";
import { firstPrompt } from "./transcript.ts";
import { sessionsInTabs, watchTerminalFocus } from "./terminal-focus.ts";

/** Runs until SIGINT or SIGTERM. */
export async function runAgent() {
  const config = await loadConfig();
  const store = new Store(config.dbPath);
  const hub = new SessionHub(store, Date.now, (id, transcriptPath) => firstPrompt(id, { transcriptPath }));
  const front = new FrontApp();
  const servers = startServers({
    hub,
    front,
    token: config.token,
    hookPort: HOOK_PORT,
    panelPort: PANEL_PORT,
  });
  const stopPoller = startPoller(hub);
  // Both focus sources coexist: the one for the app in front wins, and the other waits (see FocusArbiter).
  const arbiter = new FocusArbiter(front, (id) => hub.setFocused(id));
  const stopFocus = watchDesktopFocus((id) => arbiter.desktop(id));
  // osascript only runs while Terminal is in front (or no overlay has said), and Terminal coming to the front ticks at once.
  const stopTerminalFocus = watchTerminalFocus((id) => hub.setFocused(id), {
    enabled: () => front.terminalMayRun(),
    wakeOn: (wake) => front.subscribe((app) => app === "terminal" && wake()),
    alive: (id) => hub.get(id)?.live ?? false,
    current: () => hub.focusedId,
    // Which background sessions have a tab, so the overlay's jump can visit them.
    onTabs: (titles) =>
      hub.setTabbed(
        sessionsInTabs(
          titles,
          hub.snapshot().filter((s) => s.live).map((s) => ({ id: s.id, title: hub.titleOf(s.id), background: s.kind === BACKGROUND_KIND })),
        ),
      ),
    // A tab on a background session runs a client whose tty is not the session's: match by the tab's title.
    sessionForTitle: (name) => {
      const matches = hub.snapshot().filter((s) => s.live && hub.titleOf(s.id) === name);
      return matches.length === 1 ? matches[0]!.id : null;
    },
  });
  const pruneTimer = setInterval(() => hub.prune(), 10 * 60 * 1000);
  // One line per change, so the log shows when Terminal is asked and which focus source applies.
  front.subscribe((app) => console.log(`${new Date().toLocaleTimeString("en-GB", { hour12: false })}  front app → ${app}`));

  hub.subscribe((change) => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    if (change.type === "removed") return console.log(`${time}  ${change.id.slice(0, 8)}  removed`);
    if (change.type === "focus") return console.log(`${time}  focus → ${change.id ? hub.get(change.id)?.name ?? change.id : "none"}`);
    const s = change.session;
    const flags = `${s.live ? "" : " (not live)"}${s.pinned ? " ★" : ""}`;
    console.log(`${time}  ${s.id.slice(0, 8)}  ${s.state.padEnd(16)} ${s.name}${flags}  ${s.activity ?? ""}`);
  });

  console.log(`tomari agent
  hooks : http://127.0.0.1:${HOOK_PORT}/hook
  panel : ws://127.0.0.1:${PANEL_PORT}/ws
  data  : ${config.dbPath}
`);

  function shutdown() {
    clearInterval(pruneTimer);
    stopPoller();
    stopFocus();
    stopTerminalFocus();
    servers.stop();
    store.close();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
