/**
 * SQLite persistence. Observed session state and the user's pins live in separate
 * tables: the first can be rebuilt from Claude at any time, the second cannot.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DEFAULT_ICON, type AccountLimits, type SessionIcon, type SessionState } from "../../shared/protocol.ts";
import type { SessionRecord } from "./state.ts";

export interface Pin {
  sessionId: string;
  position: number;
  icon: SessionIcon;
}

interface SessionRow {
  id: string;
  name: string | null;
  cwd: string;
  state: string;
  activity: string | null;
  live: number;
  pid: number | null;
  state_since: number;
  last_event_at: number;
}

interface PinRow {
  session_id: string;
  position: number;
  character: string;
  color: string;
}

/** Local calendar date of an epoch-ms time, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class Store {
  private db: Database;

  /** `path` may be ":memory:". */
  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        name          TEXT,
        cwd           TEXT NOT NULL,
        state         TEXT NOT NULL,
        activity      TEXT,
        live          INTEGER NOT NULL,
        pid           INTEGER,
        state_since   INTEGER NOT NULL,
        last_event_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pins (
        session_id TEXT PRIMARY KEY,
        position   INTEGER NOT NULL,
        character  TEXT NOT NULL,
        color      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS last_limits (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spend_days (
        day TEXT PRIMARY KEY,
        usd REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spend_sessions (
        session_id TEXT PRIMARY KEY,
        last_cost  REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  loadSessions(): SessionRecord[] {
    return this.db
      .query<SessionRow, []>("SELECT * FROM sessions")
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        cwd: r.cwd,
        state: r.state as SessionState,
        activity: r.activity,
        live: r.live === 1,
        pid: r.pid,
        stateSince: r.state_since,
        lastEventAt: r.last_event_at,
      }));
  }

  saveSession(s: SessionRecord) {
    this.db
      .query(
        `INSERT INTO sessions (id, name, cwd, state, activity, live, pid, state_since, last_event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, cwd = excluded.cwd, state = excluded.state, activity = excluded.activity,
           live = excluded.live, pid = excluded.pid, state_since = excluded.state_since,
           last_event_at = excluded.last_event_at`,
      )
      .run(s.id, s.name, s.cwd, s.state, s.activity, s.live ? 1 : 0, s.pid, s.stateSince, s.lastEventAt);
  }

  deleteSession(id: string) {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  loadPins(): Map<string, Pin> {
    const rows = this.db.query<PinRow, []>("SELECT * FROM pins ORDER BY position").all();
    return new Map(
      rows.map((r) => [r.session_id, { sessionId: r.session_id, position: r.position, icon: { character: r.character, color: r.color } }]),
    );
  }

  /** Appends to the pin order with the default icon; no-op if already pinned. */
  pin(sessionId: string) {
    this.db
      .query(
        `INSERT OR IGNORE INTO pins (session_id, position, character, color, created_at)
         VALUES (?, (SELECT COALESCE(MAX(position) + 1, 0) FROM pins), ?, ?, ?)`,
      )
      .run(sessionId, DEFAULT_ICON.character, DEFAULT_ICON.color, Date.now());
  }

  unpin(sessionId: string) {
    this.db.query("DELETE FROM pins WHERE session_id = ?").run(sessionId);
  }

  /** Pins the session if it isn't yet, then sets its icon. */
  setIcon(sessionId: string, icon: SessionIcon) {
    this.db
      .query(
        `INSERT INTO pins (session_id, position, character, color, created_at)
         VALUES (?, (SELECT COALESCE(MAX(position) + 1, 0) FROM pins), ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET character = excluded.character, color = excluded.color`,
      )
      .run(sessionId, icon.character, icon.color, Date.now());
  }

  /**
   * Copies pins, with the sessions they point at, from another agent's database (claude-panel's).
   * Does nothing once this store has pins of its own. Returns how many pins it copied.
   */
  importPinsFrom(path: string): number {
    if (!existsSync(path) || this.db.query("SELECT 1 FROM pins LIMIT 1").get()) return 0;
    this.db.query("ATTACH DATABASE ? AS source").run(path);
    try {
      return this.db.transaction(() => {
        this.db.exec(`
          INSERT OR IGNORE INTO sessions (id, name, cwd, state, activity, live, pid, state_since, last_event_at)
          SELECT id, name, cwd, state, activity, live, pid, state_since, last_event_at FROM source.sessions
          WHERE id IN (SELECT session_id FROM source.pins)`);
        return this.db
          .query(
            `INSERT OR IGNORE INTO pins (session_id, position, character, color, created_at)
             SELECT session_id, position, character, color, created_at FROM source.pins`,
          )
          .run().changes;
      })();
    } finally {
      this.db.exec("DETACH DATABASE source");
    }
  }

  /**
   * Adds what `sessionId` cost since its last reading to `day`'s total and returns that total.
   * A cost below the last one means the session started over, so the whole of it is new.
   * Only the last cost per session is kept, so a restart of the agent doesn't count a session twice.
   */
  recordCost(sessionId: string, day: string, cost: number, now: number): number {
    return this.db.transaction(() => {
      const last = this.db.query<{ last_cost: number }, [string]>("SELECT last_cost FROM spend_sessions WHERE session_id = ?").get(sessionId);
      const delta = last === null ? cost : cost >= last.last_cost ? cost - last.last_cost : cost;
      this.db
        .query(
          `INSERT INTO spend_sessions (session_id, last_cost, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET last_cost = excluded.last_cost, updated_at = excluded.updated_at`,
        )
        .run(sessionId, cost, now);
      if (delta > 0) {
        this.db
          .query("INSERT INTO spend_days (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd")
          .run(day, delta);
      }
      return this.spendOn(day);
    })();
  }

  /** The account limits as last reported, so a restart still has something to show until Claude Code reports again. */
  saveLimits(limits: AccountLimits) {
    this.db
      .query("INSERT INTO last_limits (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(JSON.stringify(limits));
  }

  loadLimits(): AccountLimits | null {
    const row = this.db.query<{ json: string }, []>("SELECT json FROM last_limits WHERE id = 1").get();
    if (!row) return null;
    try {
      return JSON.parse(row.json) as AccountLimits;
    } catch {
      return null;
    }
  }

  spendOn(day: string): number {
    return this.db.query<{ usd: number }, [string]>("SELECT usd FROM spend_days WHERE day = ?").get(day)?.usd ?? 0;
  }

  /** Drops spend records older than `maxAgeMs`. */
  pruneSpend(now: number, maxAgeMs: number) {
    this.db.query("DELETE FROM spend_sessions WHERE updated_at < ?").run(now - maxAgeMs);
    this.db.query("DELETE FROM spend_days WHERE day < ?").run(localDay(now - maxAgeMs));
  }

  close() {
    this.db.close();
  }
}
