import { $ } from "bun";
import type { PanelConfig, SessionHostId } from "../../shared/protocol.ts";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BIN_DIR, CLAUDE_PANEL_CONFIG, CLAUDE_PANEL_DB, CLAUDE_SETTINGS, CONFIG_FILE, DATA_DIR, DB_FILE, LOG_DIR, loadConfig, OVERLAY_DEFAULTS, panelUrls, PERCH, saveHost } from "./config.ts";
import { isLoaded, LEGACY_AGENT_LABEL, PERCH_LABELS, tomariJobs, plistPath, remove, start, stop } from "./launchd.ts";
import { writeHooks } from "./settings.ts";
import { Store } from "./store.ts";

/** What a release ships next to the `tomari` binary, and setup copies into BIN_DIR. */
const SHIPPED = ["tomari", "tomari-overlay", "Tomari_TomariCore.bundle"];

/** `host` chooses where sessions are opened; null keeps the one already saved. */
export async function setup({ pi, host }: { pi: boolean; host: SessionHostId | null }) {
  const source = dirname(process.execPath);
  const missing = SHIPPED.filter((name) => !existsSync(`${source}/${name}`));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not found next to ${process.execPath}; run setup from a release build`);
  }
  const jobs = tomariJobs({ binDir: BIN_DIR, logDir: LOG_DIR }, { lan: pi });

  for (const job of jobs) await stop(job.label);
  // Its agent holds the same ports, and stopping it first leaves its database quiet for the import.
  const replacedClaudePanel = (await isLoaded(LEGACY_AGENT_LABEL)) || existsSync(plistPath(LEGACY_AGENT_LABEL));
  if (replacedClaudePanel) await remove(LEGACY_AGENT_LABEL);
  const migratedPerch = await migrateFromPerch();

  if (source !== BIN_DIR) await copyInto(source, BIN_DIR);
  if (!existsSync(CONFIG_FILE) && existsSync(CLAUDE_PANEL_CONFIG)) {
    await mkdir(DATA_DIR, { recursive: true });
    await copyFile(CLAUDE_PANEL_CONFIG, CONFIG_FILE);
    await chmod(CONFIG_FILE, 0o600);
  }
  if (host) await saveHost(host);
  const config = await loadConfig();
  const store = new Store(config.dbPath);
  const imported = store.importPinsFrom(CLAUDE_PANEL_DB);
  store.close();
  const hooksChanged = await writeHooks({ install: true });
  // A strip started by hand would hold the single-instance lock, and the LaunchAgent's copy would quit.
  await $`pkill -x tomari-overlay`.quiet().nothrow();
  for (const job of jobs) await start(job);

  console.log(`Tomari is installed and running.
  binaries : ${BIN_DIR}
  data     : ${DATA_DIR}
  logs     : ${LOG_DIR}
  host     : ${config.host === "desktop" ? "the Claude desktop app" : "Ghostty"} (change it with \`tomari host\`)
  hooks    : ${hooksChanged ? "added to" : "already in"} ${CLAUDE_SETTINGS}`);
  if (migratedPerch) console.log("  moved your Perch install, with its pins, icons and token, into Tomari");
  if (replacedClaudePanel) console.log("  replaced claude-panel's agent (com.claude-panel.agent)");
  if (imported > 0) console.log(`  imported ${imported} pinned session${imported === 1 ? "" : "s"} from claude-panel`);
  if (pi) {
    const pairing: PanelConfig = { agentUrls: await panelUrls(), token: config.token };
    console.log(`\nThe agent also listens on your network. Pair the Pi with this config.json:\n${JSON.stringify(pairing, null, 2)}`);
  }
}

/** Stops a Perch install and moves its data, logs and strip edge to Tomari's names. False when there was none. */
async function migrateFromPerch(): Promise<boolean> {
  let found = false;
  for (const label of PERCH_LABELS) {
    if ((await isLoaded(label)) || existsSync(plistPath(label))) {
      await remove(label);
      found = true;
    }
  }
  await $`pkill -x perch-overlay`.quiet().nothrow();

  if (existsSync(PERCH.dataDir) && !existsSync(DATA_DIR)) {
    await rm(`${PERCH.dataDir}/bin`, { recursive: true, force: true });
    await rename(PERCH.dataDir, DATA_DIR);
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = `${DATA_DIR}/${PERCH.db}${suffix}`;
      if (existsSync(from)) await rename(from, `${DB_FILE}${suffix}`);
    }
    found = true;
  }
  await rm(PERCH.logDir, { recursive: true, force: true });

  if ((await $`defaults read ${PERCH.defaults}`.quiet().nothrow()).exitCode === 0) {
    await $`defaults export ${PERCH.defaults} - | defaults import ${OVERLAY_DEFAULTS} -`.quiet().nothrow();
    await $`defaults delete ${PERCH.defaults}`.quiet().nothrow();
  }
  return found;
}

/** Each item lands under a temporary name, then replaces the old one in a single rename. */
async function copyInto(source: string, target: string) {
  await mkdir(target, { recursive: true });
  for (const name of SHIPPED) {
    const temporary = `${target}/.${name}.new`;
    await rm(temporary, { recursive: true, force: true });
    await $`cp -Rp ${`${source}/${name}`} ${temporary}`.quiet();
    await rm(`${target}/${name}`, { recursive: true, force: true });
    await rename(temporary, `${target}/${name}`);
  }
}

export async function uninstall({ purge }: { purge: boolean }) {
  for (const job of tomariJobs({ binDir: BIN_DIR, logDir: LOG_DIR }, { lan: false })) await remove(job.label);
  await $`pkill -f ${`${BIN_DIR}/`}`.quiet().nothrow();
  const hooksRemoved = await writeHooks({ install: false });
  await rm(BIN_DIR, { recursive: true, force: true });

  const deleteData = purge || (process.stdin.isTTY && prompt(`Delete your pins and icons in ${DATA_DIR}? [y/N]`)?.trim().toLowerCase() === "y");
  if (deleteData) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await rm(LOG_DIR, { recursive: true, force: true });
  }

  console.log(`Tomari is uninstalled.
  hooks : ${hooksRemoved ? "removed from" : "were not in"} ${CLAUDE_SETTINGS}
  data  : ${deleteData ? "deleted" : `kept in ${DATA_DIR}`}`);
  if (existsSync(CLAUDE_PANEL_DB)) {
    console.log("\nTo bring back claude-panel's agent: in claude-panel, `bun run setup`.");
  }
}
