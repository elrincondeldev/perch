/**
 * Live view of all sessions and pins, persisted through Store. Listeners hear only
 * about changes the panel can see, so a burst of identical hook events yields one message.
 */
import { basename } from "node:path";
import { DEFAULT_ICON, type AccountLimits, type DailySpend, type LimitWindow, type PanelSession, type SessionIcon, type SessionUsage } from "../../shared/protocol.ts";
import { applyHookEvent, reconcile, type AgentEntry, type HookEvent, type SessionRecord } from "./state.ts";
import { localDay, type Pin, type Store } from "./store.ts";
import type { StatuslineReading } from "./usage.ts";

export type HubChange =
  | { type: "session"; session: PanelSession }
  | { type: "removed"; id: string }
  | { type: "focus"; id: string | null }
  | { type: "limits"; limits: AccountLimits }
  | { type: "spend"; spend: DailySpend };
export type HubListener = (change: HubChange) => void;

const DAY_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 4 * 60 * 1000;
const VISIBLE: (keyof SessionRecord)[] = ["name", "cwd", "state", "activity", "live", "stateSince"];

export class SessionHub {
  private records = new Map<string, SessionRecord>();
  private pins: Map<string, Pin>;
  private listeners = new Set<HubListener>();
  /** Latest statusline reading per session, and the account's limits. In memory only: both go stale within hours. */
  private usage = new Map<string, SessionUsage>();
  private limits: AccountLimits | null = null;
  /** Session in front in the desktop app; not persisted. */
  focusedId: string | null = null;

  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {
    for (const rec of store.loadSessions()) this.records.set(rec.id, rec);
    this.pins = store.loadPins();
    this.limits = store.loadLimits();
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

  /** All known sessions; the panel decides which to show. */
  snapshot(): PanelSession[] {
    return [...this.records.values()].map((rec) => this.toPanel(rec));
  }

  handleHook(event: HookEvent) {
    this.commit(applyHookEvent(this.records.get(event.session_id), event, this.now()));
  }

  handleAgents(agents: AgentEntry[]) {
    for (const rec of reconcile(this.records, agents, this.now())) this.commit(rec);
  }

  /**
   * The account limits as last reported, or null when none is known. A window whose reset time has passed is kept:
   * the overlay shows it as 0 % rather than losing it until the next report.
   */
  currentLimits(): AccountLimits | null {
    return this.limits;
  }

  /** What all sessions have cost today, or null while nothing has. */
  currentSpend(): DailySpend | null {
    const day = localDay(this.now());
    const usd = this.store.spendOn(day);
    return usd > 0 ? { day, usd } : null;
  }

  /**
   * Records a statusline reading. A reading without `rate_limits` (a session billed by API key)
   * leaves the known limits alone. Usage for a session the hub hasn't seen yet is kept until it shows up.
   */
  handleStatusline(reading: StatuslineReading) {
    const { sessionId, usage, limits } = reading;
    if (!sameValues(this.usage.get(sessionId), usage)) {
      this.usage.set(sessionId, usage);
      const rec = this.records.get(sessionId);
      if (rec) this.emit({ type: "session", session: this.toPanel(rec) });
    }
    if (usage.costUsd !== null) {
      const day = localDay(this.now());
      const before = this.store.spendOn(day);
      const usd = this.store.recordCost(sessionId, day, usage.costUsd, this.now());
      if (usd !== before) this.emit({ type: "spend", spend: { day, usd } });
    }
    if (limits) this.setLimits(limits);
  }

  /** Records account limits from any source; announced only when they differ from what is known. */
  setLimits(reported: AccountLimits) {
    const limits = mergeLimits(this.limits, reported, this.now());
    // Identical limits are announced again only as a heartbeat, so the overlay can tell "unchanged" from "no news".
    const heartbeat = this.limits !== null && limits.updatedAt - this.limits.updatedAt >= HEARTBEAT_MS;
    if (sameLimits(this.limits, limits) && !heartbeat) return;
    this.limits = limits;
    this.store.saveLimits(limits);
    this.emit({ type: "limits", limits });
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
    if (pinned) this.store.pin(id);
    else this.store.unpin(id);
    this.pins = this.store.loadPins();
    this.emit({ type: "session", session: this.toPanel(rec) });
    return true;
  }

  /** Pins the session if needed. False if the session is unknown. */
  setIcon(id: string, icon: SessionIcon): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.store.setIcon(id, icon);
    this.pins = this.store.loadPins();
    this.emit({ type: "session", session: this.toPanel(rec) });
    return true;
  }

  setFocused(id: string | null) {
    if (id === this.focusedId) return;
    this.focusedId = id;
    this.emit({ type: "focus", id });
  }

  /** Forgets ended, unpinned sessions whose state is older than `maxAgeMs`. */
  prune(maxAgeMs = DAY_MS) {
    this.store.pruneSpend(this.now(), 14 * DAY_MS);
    const cutoff = this.now() - maxAgeMs;
    for (const rec of this.records.values()) {
      if (rec.state === "ended" && !this.pins.has(rec.id) && rec.stateSince < cutoff) {
        this.records.delete(rec.id);
        this.store.deleteSession(rec.id);
        this.usage.delete(rec.id);
        this.emit({ type: "removed", id: rec.id });
      }
    }
  }

  private commit(next: SessionRecord) {
    const prev = this.records.get(next.id);
    this.records.set(next.id, next);
    this.store.saveSession(next);
    if (!prev || VISIBLE.some((k) => prev[k] !== next[k])) {
      this.emit({ type: "session", session: this.toPanel(next) });
    }
  }

  private emit(change: HubChange) {
    for (const listener of this.listeners) listener(change);
  }

  private toPanel(rec: SessionRecord): PanelSession {
    const pin = this.pins.get(rec.id);
    const usage = this.usage.get(rec.id);
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
      ...(usage ? { usage } : {}),
    };
  }
}

function sameValues<T extends object>(a: T | undefined, b: T) {
  return a !== undefined && (Object.keys(b) as (keyof T)[]).every((k) => a[k] === b[k]);
}

/**
 * Folds a report into what is known, window by window. A window a report lacks keeps its last value, and a report
 * of "no window running" (reset time 0) never replaces a window that is still counting.
 */
function mergeLimits(known: AccountLimits | null, reported: AccountLimits, now: number): AccountLimits {
  if (!known) return reported;
  const pick = (old: LimitWindow | null, next: LimitWindow | null) => {
    if (next === null) return old;
    if (next.resetsAt === 0 && old !== null && old.resetsAt > now) return old;
    return next;
  };
  return { fiveHour: pick(known.fiveHour, reported.fiveHour), sevenDay: pick(known.sevenDay, reported.sevenDay), updatedAt: reported.updatedAt };
}

/** Ignores `updatedAt`, so a repeated reading isn't announced again. */
function sameLimits(a: AccountLimits | null, b: AccountLimits) {
  const sameWindow = (x: AccountLimits["fiveHour"], y: AccountLimits["fiveHour"]) =>
    x === y || (x !== null && y !== null && x.usedPct === y.usedPct && x.resetsAt === y.resetsAt);
  return a !== null && sameWindow(a.fiveHour, b.fiveHour) && sameWindow(a.sevenDay, b.sevenDay);
}
