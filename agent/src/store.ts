/**
 * SQLite persistence. Observed session state and the user's pins live in separate
 * tables: the first can be rebuilt from Claude at any time, the second cannot.
 * Pins are keyed by session name (see pinKey in hub.ts), so they outlive session ids.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DEFAULT_ICON, type SessionIcon, type SessionState } from "../../shared/protocol.ts";
import type { SessionRecord } from "./state.ts";

export interface Pin {
  /** The session's name, or its id while it has none. */
  key: string;
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
  pin_key: string;
  position: number;
  character: string;
  color: string;
}

export class Store {
  private db: Database;

  /** `path` may be ":memory:". */
  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migratePinsById();
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
        pin_key    TEXT PRIMARY KEY,
        position   INTEGER NOT NULL,
        character  TEXT NOT NULL,
        color      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Databases from before pins went by name: each pin moves from its session's id to that
   * session's name. Two pins that land on one name leave the first.
   */
  private migratePinsById() {
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(pins)").all();
    if (!columns.some((c) => c.name === "session_id")) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE pins_by_key (
          pin_key    TEXT PRIMARY KEY,
          position   INTEGER NOT NULL,
          character  TEXT NOT NULL,
          color      TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO pins_by_key (pin_key, position, character, color, created_at)
          SELECT COALESCE(s.name, p.session_id), p.position, p.character, p.color, p.created_at
          FROM pins p LEFT JOIN sessions s ON s.id = p.session_id ORDER BY p.position;
        DROP TABLE pins;
        ALTER TABLE pins_by_key RENAME TO pins;
      `);
    })();
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
      rows.map((r) => [r.pin_key, { key: r.pin_key, position: r.position, icon: { character: r.character, color: r.color } }]),
    );
  }

  /** Appends to the pin order with the default icon; no-op if already pinned. */
  pin(key: string) {
    this.db
      .query(
        `INSERT OR IGNORE INTO pins (pin_key, position, character, color, created_at)
         VALUES (?, (SELECT COALESCE(MAX(position) + 1, 0) FROM pins), ?, ?, ?)`,
      )
      .run(key, DEFAULT_ICON.character, DEFAULT_ICON.color, Date.now());
  }

  unpin(key: string) {
    this.db.query("DELETE FROM pins WHERE pin_key = ?").run(key);
  }

  /** Pins the key if it isn't yet, then sets its icon. */
  setIcon(key: string, icon: SessionIcon) {
    this.db
      .query(
        `INSERT INTO pins (pin_key, position, character, color, created_at)
         VALUES (?, (SELECT COALESCE(MAX(position) + 1, 0) FROM pins), ?, ?, ?)
         ON CONFLICT(pin_key) DO UPDATE SET character = excluded.character, color = excluded.color`,
      )
      .run(key, icon.character, icon.color, Date.now());
  }

  /** Hands the pin of `from` to `to`, unless `to` has one already; `from` loses it either way. */
  movePin(from: string, to: string) {
    this.db.transaction(() => {
      this.db.query("UPDATE OR IGNORE pins SET pin_key = ? WHERE pin_key = ?").run(to, from);
      this.db.query("DELETE FROM pins WHERE pin_key = ?").run(from);
    })();
  }

  /**
   * Copies pins, with the sessions they point at, from another agent's database (claude-panel's,
   * whose pins go by session id). Does nothing once this store has pins of its own. Returns how many pins it copied.
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
            `INSERT OR IGNORE INTO pins (pin_key, position, character, color, created_at)
             SELECT COALESCE(s.name, p.session_id), p.position, p.character, p.color, p.created_at
             FROM source.pins p LEFT JOIN source.sessions s ON s.id = p.session_id ORDER BY p.position`,
          )
          .run().changes;
      })();
    } finally {
      this.db.exec("DETACH DATABASE source");
    }
  }

  close() {
    this.db.close();
  }
}
