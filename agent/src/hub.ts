/**
 * Live view of all sessions and pins, persisted through Store. Listeners hear only
 * about changes the panel can see, so a burst of identical hook events yields one message.
 */
import { basename } from "node:path";
import { BACKGROUND_KIND, DEFAULT_ICON, type LibraryEntry, type PanelSession, type SessionIcon } from "../../shared/protocol.ts";
import { applyHookEvent, reconcile, type AgentEntry, type HookEvent, type SessionRecord } from "./state.ts";
import type { Pin, Store } from "./store.ts";

export type HubChange =
  | { type: "session"; session: PanelSession }
  | { type: "removed"; id: string }
  | { type: "focus"; id: string | null };
export type HubListener = (change: HubChange) => void;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the poll is ignored for a session just stopped: `claude agents` may list the process a few seconds more. */
const STOPPED_GRACE_MS = 30_000;
const VISIBLE: (keyof SessionRecord)[] = ["name", "cwd", "state", "activity", "live", "stateSince", "kind"];

export class SessionHub {
  private records = new Map<string, SessionRecord>();
  private pins: Map<string, Pin>;
  private listeners = new Set<HubListener>();
  /** Start of each session's first prompt, kept only in memory: it is never written to the store. */
  private prompts = new Map<string, string>();
  /** Where each session's transcript lives, from the hook payload; in memory only. */
  private transcripts = new Map<string, string>();
  /** Sessions whose first prompt was already looked up in the transcript, found or not: each is read once. */
  private lookedUp = new Set<string>();
  /** Sessions stopped from the panel → when the poll may list them again; in memory only. */
  private stoppedUntil = new Map<string, number>();
  /** Background sessions shown in some Terminal tab; in memory only. */
  private tabbed = new Set<string>();
  /** The label the panel last saw for each session. */
  private labels = new Map<string, string>();
  /** Session in front in the terminal or desktop app; not persisted. */
  focusedId: string | null = null;

  constructor(
    private store: Store,
    private now: () => number = Date.now,
    /** Reads a session's first prompt from its transcript; the default finds nothing. */
    private readPrompt: (sessionId: string, transcriptPath?: string) => Promise<string | null> = async () => null,
  ) {
    for (const rec of store.loadSessions()) this.records.set(rec.id, rec);
    this.pins = store.loadPins();
    this.relabel();
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

  /**
   * Running sessions as library entries, so the + can pin one that the strip hides. Background
   * sessions (`claude agents`, `--bg`) are left out: they have no terminal to open them in.
   */
  liveEntries(): LibraryEntry[] {
    return [...this.records.values()]
      .filter((rec) => rec.live && rec.kind !== BACKGROUND_KIND)
      .map((rec) => ({
        id: rec.id,
        name: this.labelOf(rec),
        cwd: rec.cwd,
        lastActivityAt: rec.lastEventAt > 0 ? rec.lastEventAt : rec.stateSince, // 0: only the poll has seen it
        pinned: this.pins.has(rec.id),
      }));
  }

  handleHook(event: HookEvent) {
    if (typeof event.transcript_path === "string") {
      // A lookup that ran before any path was known may have missed: the first path earns one more try.
      if (!this.transcripts.has(event.session_id) && !this.prompts.has(event.session_id)) this.lookedUp.delete(event.session_id);
      this.transcripts.set(event.session_id, event.transcript_path);
    }
    if (event.hook_event_name === "UserPromptSubmit" && typeof event.prompt === "string" && !this.prompts.has(event.session_id)) {
      const snippet = snippetOf(event.prompt);
      if (snippet) this.prompts.set(event.session_id, snippet);
    }
    this.commit(applyHookEvent(this.records.get(event.session_id), event, this.now()));
  }

  handleAgents(agents: AgentEntry[]) {
    const now = this.now();
    for (const [id, until] of this.stoppedUntil) if (until <= now) this.stoppedUntil.delete(id);
    const polled = agents.filter((agent) => !this.stoppedUntil.has(agent.sessionId));
    for (const rec of reconcile(this.records, polled, now)) this.commit(rec);
  }

  /**
   * Ends live sessions whose process is gone: a closed tab often skips SessionEnd, and if
   * `claude agents` fails nothing else would. `pids` fills in sessions the hooks alone have seen.
   * A session with no known pid is left alone, and one ends only when every pid it is known by is
   * dead: a resumed session gets a new pid before the poll replaces the recorded one.
   */
  endDead(isAlive: (pid: number) => boolean, pids: ReadonlyMap<string, number> = new Map()) {
    for (const rec of [...this.records.values()]) {
      const known = [rec.pid, pids.get(rec.id)].filter((pid): pid is number => pid != null);
      if (rec.live && known.length > 0 && !known.some(isAlive)) {
        this.commit(this.ended(rec));
      }
    }
  }

  private ended(rec: SessionRecord): SessionRecord {
    return { ...rec, state: "ended", activity: null, live: false, pid: null, stateSince: this.now() };
  }

  /** Starts tracking a session that is not running, e.g. a desktop session about to be pinned. No-op if known. */
  adopt(id: string, name: string | null, cwd: string, since: number) {
    if (this.records.has(id)) return;
    this.commit({ id, name, cwd, state: "ended", activity: null, live: false, pid: null, stateSince: since, lastEventAt: 0 });
  }

  /** Ends a session whose process was just stopped, without waiting for the poll. False if unknown. */
  endSession(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.commit(this.ended(rec));
    this.stoppedUntil.set(id, this.now() + STOPPED_GRACE_MS);
    if (this.focusedId === id) this.setFocused(null);
    return true;
  }

  /** The session's real title, or null if it has none: unlike `get(id).name`, never the display label. */
  titleOf(id: string): string | null {
    return this.records.get(id)?.name ?? null;
  }

  /** Replaces the set of sessions shown in a tab; announces only the background sessions whose flag changed. */
  setTabbed(ids: ReadonlySet<string>) {
    const changed = [...new Set([...this.tabbed, ...ids])].filter((id) => this.tabbed.has(id) !== ids.has(id));
    this.tabbed = new Set(ids);
    for (const id of changed) if (this.records.get(id)?.kind === BACKGROUND_KIND) this.emitSession(id);
  }

  /** False if the session is unknown. */
  setPinned(id: string, pinned: boolean): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (pinned) this.store.pin(id);
    else this.store.unpin(id);
    this.pins = this.store.loadPins();
    this.emit({ type: "session", session: this.toPanel(rec) });
    this.announceRelabeled(); // a pinned ended session starts to count for label clashes
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
    const cutoff = this.now() - maxAgeMs;
    for (const rec of this.records.values()) {
      if (rec.state === "ended" && !this.pins.has(rec.id) && rec.stateSince < cutoff) {
        this.records.delete(rec.id);
        this.prompts.delete(rec.id);
        this.labels.delete(rec.id);
        this.transcripts.delete(rec.id);
        this.lookedUp.delete(rec.id);
        this.stoppedUntil.delete(rec.id);
        this.store.deleteSession(rec.id);
        this.emit({ type: "removed", id: rec.id });
      }
    }
    this.announceRelabeled();
  }

  private commit(next: SessionRecord) {
    const prev = this.records.get(next.id);
    this.records.set(next.id, next);
    this.store.saveSession(next);
    const relabeled = this.relabel();
    if (!prev || VISIBLE.some((k) => prev[k] !== next[k]) || relabeled.includes(next.id)) {
      this.emit({ type: "session", session: this.toPanel(next) });
    }
    for (const id of relabeled) if (id !== next.id) this.emitSession(id);
  }

  private emitSession(id: string) {
    const rec = this.records.get(id);
    if (rec) this.emit({ type: "session", session: this.toPanel(rec) });
  }

  private announceRelabeled() {
    for (const id of this.relabel()) this.emitSession(id);
  }

  /** Recomputes every label; returns the ids whose label changed since the last call. */
  private relabel(): string[] {
    const clashing = this.clashingIds();
    this.requestMissingPrompts(clashing);
    const next = this.computeLabels(clashing);
    const changed = [...next].filter(([id, label]) => this.labels.get(id) !== label).map(([id]) => id);
    this.labels = next;
    return changed;
  }

  /** Reads the first prompt from the transcript, in the background, for a session that needs a snippet and has none. */
  private lookUpPrompt(id: string) {
    if (this.lookedUp.has(id)) return;
    this.lookedUp.add(id);
    this.readPrompt(id, this.transcripts.get(id))
      .then((prompt) => {
        const snippet = prompt ? snippetOf(prompt) : "";
        if (!snippet || this.prompts.has(id) || !this.records.has(id)) return; // a prompt seen live wins
        this.prompts.set(id, snippet);
        this.announceRelabeled();
      })
      .catch(() => {}); // fail soft: the short id stays
  }

  private labelOf(rec: SessionRecord) {
    return this.labels.get(rec.id) ?? this.baseLabel(rec);
  }

  private baseLabel(rec: SessionRecord) {
    return rec.name ?? basename(rec.cwd);
  }

  /** Whether the strip shows the session: it runs, or somebody pinned it. Ended sessions nobody pinned are not on screen. */
  private isVisible(rec: SessionRecord) {
    return rec.live || this.pins.has(rec.id);
  }

  /** Untitled visible sessions whose plain label another visible session shares. */
  private clashingIds(): Set<string> {
    const shown = [...this.records.values()].filter((rec) => this.isVisible(rec));
    const count = new Map<string, number>();
    for (const rec of shown) count.set(this.baseLabel(rec), (count.get(this.baseLabel(rec)) ?? 0) + 1);
    return new Set(shown.filter((rec) => rec.name === null && (count.get(this.baseLabel(rec)) ?? 0) > 1).map((rec) => rec.id));
  }

  /** Starts a transcript read for each clashing session that has no snippet yet; it relabels when one lands. */
  private requestMissingPrompts(clashing: ReadonlySet<string>) {
    for (const id of clashing) if (!this.prompts.has(id)) this.lookUpPrompt(id);
  }

  /**
   * A clashing session gets the start of its first prompt (a short id if the prompt is unknown, e.g.
   * after a restart); a clash that is left, because the prompts start alike, gets the short id too.
   * Pure: it reads state and starts nothing.
   */
  private computeLabels(clashing: ReadonlySet<string>): Map<string, string> {
    const entries = [...this.records.values()].map((rec) => {
      const base = this.baseLabel(rec);
      return { rec, label: clashing.has(rec.id) ? `${base} · ${this.prompts.get(rec.id) ?? shortId(rec.id)}` : base };
    });
    const used = new Map<string, number>();
    for (const { rec, label } of entries) if (this.isVisible(rec)) used.set(label, (used.get(label) ?? 0) + 1);
    return new Map(
      entries.map(({ rec, label }) => [rec.id, clashing.has(rec.id) && (used.get(label) ?? 0) > 1 ? `${label} #${shortId(rec.id)}` : label]),
    );
  }

  private emit(change: HubChange) {
    for (const listener of this.listeners) listener(change);
  }

  private toPanel(rec: SessionRecord): PanelSession {
    const pin = this.pins.get(rec.id);
    return {
      id: rec.id,
      name: this.labelOf(rec),
      cwd: rec.cwd,
      state: rec.state,
      activity: rec.activity,
      live: rec.live,
      stateSince: rec.stateSince,
      pinned: pin !== undefined,
      position: pin?.position ?? null,
      icon: pin?.icon ?? DEFAULT_ICON,
      ...(rec.kind ? { kind: rec.kind } : {}),
      ...(rec.kind === BACKGROUND_KIND ? { inTab: this.tabbed.has(rec.id) } : {}),
    };
  }
}

const SNIPPET_LENGTH = 24;
const shortId = (id: string) => id.slice(0, 4);

/** A prompt collapsed to one line and cut to a label-sized snippet. */
function snippetOf(prompt: string) {
  const text = prompt.replace(/\s+/g, " ").trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…`;
}
