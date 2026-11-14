/**
 * Sessions known to the Claude desktop app, from its metadata files (undocumented):
 * ~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<id>.json.
 * They outlive the CLI process, which the app stops when a session sits idle.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isSessionId } from "./protocol-guard.ts";

export const DESKTOP_SESSIONS_DIR = `${homedir()}/Library/Application Support/Claude/claude-code-sessions`;

/** Without its sessions dir there is no desktop app to open sessions in. */
export function hasDesktopApp(dir = DESKTOP_SESSIONS_DIR) {
  return existsSync(dir);
}

/**
 * Cached `hasDesktopApp`: the + menu and the focus watchers ask often, and the answer rarely changes.
 * Re-checked every `ttlMs`, so installing the desktop app later still works without a restart.
 */
export function desktopProbe({ dir = DESKTOP_SESSIONS_DIR, ttlMs = 5 * 60_000, now = Date.now, exists = existsSync } = {}) {
  let checkedAt = -Infinity;
  let present = false;
  return () => {
    if (now() - checkedAt >= ttlMs) {
      present = exists(dir);
      checkedAt = now();
    }
    return present;
  };
}

/** The agent's shared probe. */
export const desktopPresent = desktopProbe();

/** `list`, skipped (no directory scan) while the probe says there is no desktop app. */
export function desktopSessionsLister(probe: () => boolean = desktopPresent, list: () => Promise<DesktopSession[]> = () => listDesktopSessions()) {
  return async (): Promise<DesktopSession[]> => (probe() ? list() : []);
}

export interface DesktopSession {
  /** The app's id, used in claude:// links. */
  localId: string;
  /** The CLI session id that hooks and `claude agents` report. */
  sessionId: string;
  title: string | null;
  cwd: string;
  lastActivityAt: number;
  archived: boolean;
}

/** Every desktop session, most recently active first. */
export async function listDesktopSessions(dir = DESKTOP_SESSIONS_DIR): Promise<DesktopSession[]> {
  const sessions: DesktopSession[] = [];
  for await (const path of scan("*/*/local_*.json", dir)) {
    const session = parse(await Bun.file(path).json().catch(() => null));
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export async function findDesktopSession(sessionId: string, dir = DESKTOP_SESSIONS_DIR): Promise<DesktopSession | undefined> {
  return (await listDesktopSessions(dir)).find((s) => s.sessionId === sessionId);
}

/** CLI session id of a desktop `local_…` session. */
export async function cliSessionIdFor(localId: string, dir = DESKTOP_SESSIONS_DIR): Promise<string | null> {
  for await (const path of scan(`*/*/${localId}.json`, dir)) {
    const session = parse(await Bun.file(path).json().catch(() => null));
    if (session) return session.sessionId;
  }
  return null;
}

/** Files matching `pattern` under `dir`. A missing dir (no desktop app) has none. */
async function* scan(pattern: string, dir: string) {
  try {
    yield* new Bun.Glob(pattern).scan({ cwd: dir, absolute: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function parse(meta: Record<string, unknown> | null): DesktopSession | null {
  if (!meta || typeof meta.sessionId !== "string" || !meta.sessionId.startsWith("local_")) return null;
  if (!isSessionId(meta.cliSessionId)) return null;
  return {
    localId: meta.sessionId,
    sessionId: meta.cliSessionId,
    title: typeof meta.title === "string" ? meta.title : null,
    cwd: typeof meta.cwd === "string" ? meta.cwd : "",
    lastActivityAt: typeof meta.lastActivityAt === "number" ? meta.lastActivityAt : 0,
    archived: meta.isArchived === true,
  };
}
