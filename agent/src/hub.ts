/**
 * Live view of all sessions and pins, persisted through Store. Listeners hear only
 * about changes the panel can see, so a burst of identical hook events yields one message.
 *
 * Pins and their icons belong to the session's name (`claude -n composer`), not to its
 * id: reopening a named session gives it a new id, and the new session inherits them. Its old,
 * closed record is then forgotten, so one name never shows twice. That holds for hosts where a
 * reopened session gets a new id (SessionHost.reopensUnderNewId); where a session keeps its id,
 * as in the desktop app, two sessions may share a title, and a pin follows its session through
 * a retitle.
 */
import { basename } from "node:path";
import { DEFAULT_ICON, type PanelSession, type SessionIcon } from "../../shared/protocol.ts";
import { applyHookEvent, reconcile, type AgentEntry, type HookEvent, type SessionRecord } from "./state.ts";
import type { Pin, Store } from "./store.ts";

export type HubChange =
  | { type: "session"; session: PanelSession }
  | { type: "removed"; id: string }
  | { type: "focus"; id: string | null };
export type HubListener = (change: HubChange) => void;

const DAY_MS = 24 * 60 * 60 * 1000;
const VISIBLE: (keyof SessionRecord)[] = ["name", "cwd", "state", "activity", "live", "stateSince"];

/** What a session's pin is stored under: its name, or its id until `claude agents` names it. */
export function pinKey(rec: Pick<SessionRecord, "id" | "name">) {
  return rec.name ?? rec.id;
}

export class SessionHub {
  private records = new Map<string, SessionRecord>();
  private pins: Map<string, Pin>;
  private listeners = new Set<HubListener>();
  /** Session in front in the host; not persisted. */
  focusedId: string | null = null;

  constructor(
    private store: Store,
    private now: () => number = Date.now,
    private sameNames = true,
  ) {
    for (const rec of store.loadSessions()) this.records.set(rec.id, rec);
    this.pins = store.loadPins();
    this.replaceSameNames(sameNames);
  }

  /** Whether a session replaces a closed one of the same name; turning it on applies it to the sessions already known. */
  replaceSameNames(on: boolean) {
    this.sameNames = on;
    for (const name of new Set([...this.records.values()].map((r) => r.name))) this.dedupe(name);
  }

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  has(id: string) {
    return this.records.has(id);
  }

  get(id: string): PanelSession | undefined {
    const rec = this.records.get(id);
    return rec && this.toPanel(rec);
  }

  /** The Claude process of a running session; null when it isn't running or the poll hasn't seen it. */
  pidOf(id: string): number | null {
    const rec = this.records.get(id);
    return rec?.live ? rec.pid : null;
  }

  /** Running sessions with a known Claude process. */
  processes(): { id: string; pid: number }[] {
    return [...this.records.values()].flatMap((r) => (r.live && r.pid !== null ? [{ id: r.id, pid: r.pid }] : []));
  }

  /** All known sessions; the panel decides which to show. */
  snapshot(): PanelSession[] {
    return [...this.records.values()].map((rec) => this.toPanel(rec));
  }

  handleHook(event: HookEvent) {
    this.commit(applyHookEvent(this.records.get(event.session_id), event, this.now()));
  }

  handleAgents(agents: AgentEntry[]) {
    const changed = reconcile(this.records, agents, this.now());
    // Dedupe after the whole poll: the old record of a reopened name may be marked ended later in the batch.
    for (const rec of changed) this.commit(rec, false);
    for (const name of new Set(changed.map((r) => r.name))) this.dedupe(name);
  }

  /** Starts tracking a session that is not running, e.g. a desktop session about to be pinned. No-op if known. */
  adopt(id: string, name: string | null, cwd: string, since: number) {
    if (this.records.has(id)) return;
    this.commit({ id, name, cwd, state: "ended", activity: null, live: false, pid: null, stateSince: since, lastEventAt: 0 });
  }

  /** False if the session is unknown. */
  setPinned(id: string, pinned: boolean): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (pinned) this.store.pin(pinKey(rec));
    else this.store.unpin(pinKey(rec));
    this.pins = this.store.loadPins();
    this.emitSharing(pinKey(rec));
    return true;
  }

  /** Pins the session if needed. False if the session is unknown. */
  setIcon(id: string, icon: SessionIcon): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.store.setIcon(pinKey(rec), icon);
    this.pins = this.store.loadPins();
    this.emitSharing(pinKey(rec));
    return true;
  }

  setFocused(id: string | null) {
    if (id === this.focusedId) return;
    this.focusedId = id;
    this.emit({ type: "focus", id });
  }

  /** Forgets ended, unpinned sessions whose state is older than `maxAgeMs`. */
  prune(maxAgeMs = DAY_MS) {
    const cutoff = this.now() - maxAgeMs;
    for (const rec of this.records.values()) {
      if (rec.state === "ended" && !this.pins.has(pinKey(rec)) && rec.stateSince < cutoff) this.forget(rec.id);
    }
  }

  private commit(next: SessionRecord, dedupe = true) {
    const prev = this.records.get(next.id);
    this.records.set(next.id, next);
    this.store.saveSession(next);
    // Pinned before the poll named it: the pin moves from the id to the name. Where a session keeps its id, also on a retitle.
    if (prev && (prev.name === null || !this.sameNames) && pinKey(prev) !== pinKey(next) && this.pins.has(pinKey(prev))) {
      this.store.movePin(pinKey(prev), pinKey(next));
      this.pins = this.store.loadPins();
    }
    if (!prev || VISIBLE.some((k) => prev[k] !== next[k])) {
      this.emit({ type: "session", session: this.toPanel(next) });
    }
    if (dedupe) this.dedupe(next.name);
  }

  /** Of the records sharing a name, keeps the running ones, or else the latest; forgets the rest. */
  private dedupe(name: string | null) {
    if (name === null || !this.sameNames) return;
    const same = [...this.records.values()].filter((r) => r.name === name);
    if (same.length < 2) return;
    const live = same.filter((r) => r.live);
    const keep = live.length > 0 ? live : [same.reduce((a, b) => (b.stateSince > a.stateSince ? b : a))];
    for (const rec of same) if (!keep.includes(rec)) this.forget(rec.id);
  }

  private forget(id: string) {
    this.records.delete(id);
    this.store.deleteSession(id);
    this.emit({ type: "removed", id });
  }

  /** Announces every session under `key`, since they share its pin. */
  private emitSharing(key: string) {
    for (const rec of this.records.values()) {
      if (pinKey(rec) === key) this.emit({ type: "session", session: this.toPanel(rec) });
    }
  }

  private emit(change: HubChange) {
    for (const listener of this.listeners) listener(change);
  }

  private toPanel(rec: SessionRecord): PanelSession {
    const pin = this.pins.get(pinKey(rec));
    return {
      id: rec.id,
      name: rec.name ?? basename(rec.cwd),
      cwd: rec.cwd,
      state: rec.state,
      activity: rec.activity,
      live: rec.live,
      stateSince: rec.stateSince,
      pinned: pin !== undefined,
      position: pin?.position ?? null,
      icon: pin?.icon ?? DEFAULT_ICON,
    };
  }
}
