import { PANEL_PORT } from "../../shared/protocol.ts";
import { HOOK_PORT, loadConfig, panelUrls, saveHost } from "./config.ts";
import { desktopHost } from "./desktop-host.ts";
import { ghosttyHost } from "./ghostty-host.ts";
import { HostSwitch } from "./host.ts";
import { SessionHub } from "./hub.ts";
import { startPoller } from "./poller.ts";
import { startServers } from "./server.ts";
import { Store } from "./store.ts";

/** Runs until SIGINT or SIGTERM. `lan` opens the WebSocket to the network, for a claude-panel Pi. */
export async function runAgent({ lan }: { lan: boolean }) {
  const config = await loadConfig();
  const store = new Store(config.dbPath);
  // The host in use says whether same-named sessions replace each other; until then, none do.
  const hub = new SessionHub(store, Date.now, false);
  const ghostty = ghosttyHost(hub, { workspace: config.workspace });
  const desktop = desktopHost(hub, { inTerminal: (id) => ghostty.open(id) });
  const hosts = new HostSwitch({ desktop, ghostty }, config.host, hub, saveHost);
  const servers = startServers({
    hub,
    hosts,
    token: config.token,
    hookPort: HOOK_PORT,
    panelPort: PANEL_PORT,
    panelHost: lan ? "0.0.0.0" : "127.0.0.1",
  });
  const stopPoller = startPoller(hub, 3000, () => hosts.current.sessions());
  const pruneTimer = setInterval(() => hub.prune(), 10 * 60 * 1000);

  hub.subscribe((change) => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    if (change.type === "removed") return console.log(`${time}  ${change.id.slice(0, 8)}  removed`);
    if (change.type === "focus") return console.log(`${time}  focus → ${change.id ? hub.get(change.id)?.name ?? change.id : "none"}`);
    const s = change.session;
    const flags = `${s.live ? "" : " (not live)"}${s.pinned ? " ★" : ""}`;
    console.log(`${time}  ${s.id.slice(0, 8)}  ${s.state.padEnd(16)} ${s.name}${flags}  ${s.activity ?? ""}`);
  });
  hosts.subscribe((host) => console.log(`${new Date().toLocaleTimeString("en-GB", { hour12: false })}  host → ${host}`));

  const urls = lan ? await panelUrls() : [`ws://127.0.0.1:${PANEL_PORT}/ws`];
  console.log(`tomari agent
  hooks : http://127.0.0.1:${HOOK_PORT}/hook
  panel : ${urls.join("  ")}
  data  : ${config.dbPath}
  host  : ${config.host}${config.workspace ? `, with Ghostty limited to ${config.workspace}` : ""}
`);

  function shutdown() {
    clearInterval(pruneTimer);
    stopPoller();
    hosts.stop();
    servers.stop();
    store.close();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
