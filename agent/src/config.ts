/**
 * Where Tomari lives on disk. The data dir holds config.json with the pairing token (created on
 * first run, mode 600), tomari.db the SQLite store, and bin/ the binaries the LaunchAgents run.
 * The overlay reads the token from here too (Sources/TomariCore/AgentConfig.swift).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";

export const HOOK_PORT = 7777;

const HOME = homedir();
export const DATA_DIR = `${HOME}/Library/Application Support/tomari`;
export const BIN_DIR = `${DATA_DIR}/bin`;
export const LOG_DIR = `${HOME}/Library/Logs/tomari`;
export const CLAUDE_SETTINGS = `${HOME}/.claude/settings.json`;
/** The agent Tomari replaces: setup imports its pins. */
export const CLAUDE_PANEL_DB = `${HOME}/Library/Application Support/claude-panel/panel.db`;
export const CONFIG_FILE = `${DATA_DIR}/config.json`;
export const DB_FILE = `${DATA_DIR}/tomari.db`;
/** The overlay's defaults domain, where it keeps the strip's edge (Sources/TomariOverlay/StripController.swift). */
export const OVERLAY_DEFAULTS = "com.elrincondeldev.tomari";
/** Where Tomari lived while it was called Perch (0.1 and 0.2); setup moves it into the paths above. */
export const PERCH = {
  dataDir: `${HOME}/Library/Application Support/perch`,
  logDir: `${HOME}/Library/Logs/perch`,
  db: "perch.db",
  defaults: "com.elrincondeldev.perch",
};

export interface Config {
  dataDir: string;
  dbPath: string;
  token: string;
}

export async function loadConfig(): Promise<Config> {
  const dataDir = DATA_DIR;
  await mkdir(dataDir, { recursive: true });

  const path = CONFIG_FILE;
  const file = Bun.file(path);
  const saved: { token?: string } = (await file.exists()) ? await file.json() : {};

  if (!saved.token) {
    saved.token = randomBytes(24).toString("base64url");
    await Bun.write(path, JSON.stringify(saved, null, 2) + "\n");
    await chmod(path, 0o600);
  }

  return { dataDir, dbPath: DB_FILE, token: saved.token };
}
