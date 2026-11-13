import { PANEL_PORT } from "../../shared/protocol.ts";
import { BIN_DIR, LOG_DIR } from "./config.ts";
import { describe, tomariJobs } from "./launchd.ts";
import { hooksInstalled, statuslineInstalled } from "./settings.ts";

export async function status(version: string) {
  const [agent, overlay] = tomariJobs({ binDir: BIN_DIR, logDir: LOG_DIR }, { lan: false });
  const health = await fetch(`http://127.0.0.1:${PANEL_PORT}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json() as Promise<{ sessions: number }>)
    .catch(() => null);
  console.log(`tomari ${version}
  agent   : ${await describe(agent!.label)}
  overlay : ${await describe(overlay!.label)}
  hooks   : ${(await hooksInstalled()) ? "installed" : "not installed"}
  usage   : ${(await statuslineInstalled()) ? "statusline installed" : "statusline not installed"}
  health  : ${health ? `answering, ${health.sessions} sessions` : `no answer on :${PANEL_PORT}`}
  logs    : ${LOG_DIR}`);
}
