import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SessionRecord } from "./state.ts";
import { Store } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb() {
  const dir = mkdtempSync(`${tmpdir()}/tomari-store-`);
  dirs.push(dir);
  return `${dir}/panel.db`;
}

const ended: SessionRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "pinned and closed",
  cwd: "/src",
  state: "ended",
  activity: null,
  live: false,
  pid: null,
  stateSince: 5,
  lastEventAt: 5,
};

const UNNAMED = "22222222-2222-2222-2222-222222222222";

/** A database as claude-panel and earlier versions wrote it: pins keyed by session id. */
function byIdDb() {
  const path = tempDb();
  const old = new Database(path, { create: true });
  old.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, cwd TEXT NOT NULL, state TEXT NOT NULL, activity TEXT,
      live INTEGER NOT NULL, pid INTEGER, state_since INTEGER NOT NULL, last_event_at INTEGER NOT NULL);
    CREATE TABLE pins (session_id TEXT PRIMARY KEY, position INTEGER NOT NULL, character TEXT NOT NULL,
      color TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('${ended.id}', '${ended.name}', '/src', 'ended', NULL, 0, NULL, 5, 5);
    INSERT INTO sessions VALUES ('${UNNAMED}', NULL, '/other', 'ended', NULL, 0, NULL, 6, 6);
    INSERT INTO sessions VALUES ('33333333-3333-3333-3333-333333333333', 'never pinned', '/tmp', 'ended', NULL, 0, NULL, 7, 7);
    INSERT INTO pins VALUES ('${ended.id}', 0, 'cat', '#4f7cff', 1), ('${UNNAMED}', 1, 'ghost', '#ffd23f', 2);
  `);
  old.close();
  return path;
}

const byName = [
  { key: ended.name!, position: 0, icon: { character: "cat", color: "#4f7cff" } },
  { key: UNNAMED, position: 1, icon: { character: "ghost", color: "#ffd23f" } },
];

test("pins are stored by key, in order", () => {
  const store = new Store();
  store.pin("composer");
  store.setIcon("api-dev", { character: "cat", color: "#4f7cff" });
  store.pin("composer"); // already pinned: no-op
  expect([...store.loadPins().values()]).toEqual([
    { key: "composer", position: 0, icon: { character: "default", color: "#d97757" } },
    { key: "api-dev", position: 1, icon: { character: "cat", color: "#4f7cff" } },
  ]);
});

test("a pin moves from a session id to its name, keeping position and icon", () => {
  const store = new Store();
  store.pin("api-dev");
  store.setIcon(ended.id, { character: "cat", color: "#4f7cff" });
  store.movePin(ended.id, "composer");
  expect([...store.loadPins().values()]).toEqual([
    { key: "api-dev", position: 0, icon: { character: "default", color: "#d97757" } },
    { key: "composer", position: 1, icon: { character: "cat", color: "#4f7cff" } },
  ]);
});

test("moving onto a name that already has a pin keeps the name's and drops the id's", () => {
  const store = new Store();
  store.setIcon("composer", { character: "crab", color: "#ff6a1a" });
  store.pin(ended.id);
  store.movePin(ended.id, "composer");
  expect([...store.loadPins().keys()]).toEqual(["composer"]);
  expect(store.loadPins().get("composer")!.icon.character).toBe("crab");
});

test("a database with pins by session id opens with them under the session's name", () => {
  const store = new Store(byIdDb());
  expect([...store.loadPins().values()]).toEqual(byName);
  expect(store.loadSessions()).toHaveLength(3);
});

test("imports pins with their sessions, so pinned closed sessions still show", () => {
  const store = new Store();
  expect(store.importPinsFrom(byIdDb())).toBe(2);
  expect([...store.loadPins().values()]).toEqual(byName);
  expect(store.loadSessions().map((s) => s.id).sort()).toEqual([ended.id, UNNAMED]);
  expect(store.loadSessions().find((s) => s.id === ended.id)).toEqual(ended);
});

test("imports nothing once the store has pins of its own", () => {
  const store = new Store();
  store.pin("composer");
  expect(store.importPinsFrom(byIdDb())).toBe(0);
  expect([...store.loadPins().keys()]).toEqual(["composer"]);
});

test("a missing database imports nothing", () => {
  expect(new Store().importPinsFrom(`${tempDb()}.missing`)).toBe(0);
});
