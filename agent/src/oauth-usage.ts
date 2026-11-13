/**
 * Asks Anthropic for the account's 5-hour and 7-day limits, the call Claude Code's own `/status` makes,
 * so Tomari has them at launch instead of waiting for a session to answer.
 *
 * UNOFFICIAL: `/api/oauth/usage` is undocumented and may change or go away, and it is called with Claude Code's
 * own OAuth token. The token is read, used for one request and dropped: never logged, never written anywhere.
 * Every failure is quiet and leaves the statusline as the only source. `TOMARI_NO_OAUTH_USAGE=1` turns this off.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountLimits, LimitWindow } from "../../shared/protocol.ts";
import type { SessionHub } from "./hub.ts";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const EVERY_MS = 5 * 60 * 1000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The access token inside Claude Code's credentials JSON, or null if it is missing or already expired. */
export function tokenFrom(credentialsJson: string, now: number): string | null {
  let data: unknown;
  try {
    data = JSON.parse(credentialsJson);
  } catch {
    return null;
  }
  const oauth = isObject(data) && isObject(data.claudeAiOauth) ? data.claudeAiOauth : null;
  if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken === "") return null;
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return null;
  return oauth.accessToken;
}

function window(value: unknown): LimitWindow | null {
  if (!isObject(value)) return null;
  const { utilization, resets_at } = value;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  // No reset time and nothing used: no window is running right now, so it counts as already reset.
  // No reset time with something used makes no sense, so it is ignored rather than guessed.
  if (resets_at === null || resets_at === undefined) return utilization === 0 ? { usedPct: 0, resetsAt: 0 } : null;
  if (typeof resets_at !== "string") return null;
  const resetsAt = Date.parse(resets_at);
  return Number.isNaN(resetsAt) ? null : { usedPct: Math.min(100, Math.max(0, utilization)), resetsAt };
}

/** Null unless the body has at least one usable window. */
export function parseOauthUsage(body: unknown, now: number): AccountLimits | null {
  if (!isObject(body)) return null;
  const fiveHour = window(body.five_hour);
  const sevenDay = window(body.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay, updatedAt: now } : null;
}

function keychainCredentials(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve(null);
    execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });
}

async function credentials(): Promise<string | null> {
  return (await keychainCredentials()) ?? (await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8").catch(() => null));
}

export interface UsageSource {
  credentials: () => Promise<string | null>;
  fetch: typeof fetch;
  now: () => number;
}

export type FetchResult = { limits: AccountLimits } | { failure: string };

/** One request. A failure carries a short reason that never includes the token or the response body. */
export async function fetchLimitsResult(source: UsageSource): Promise<FetchResult> {
  try {
    const raw = await source.credentials();
    if (!raw) return { failure: "no Claude Code credentials found (Keychain access denied, or not logged in)" };
    const token = tokenFrom(raw, source.now());
    if (!token) return { failure: "the Claude Code token is missing or expired; using Claude Code once refreshes it" };
    const res = await source.fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { failure: `Anthropic answered HTTP ${res.status}` };
    const limits = parseOauthUsage(await res.json(), source.now());
    return limits ? { limits } : { failure: "the response had no usable limits" };
  } catch {
    return { failure: "the request failed (offline?)" };
  }
}

/** Null on any failure. */
export async function fetchLimits(source: UsageSource): Promise<AccountLimits | null> {
  const result = await fetchLimitsResult(source);
  return "limits" in result ? result.limits : null;
}

/** Fetches now and every few minutes. Returns a stop function. */
export function startOauthUsage(hub: SessionHub, source: UsageSource = { credentials, fetch, now: Date.now }): () => void {
  if (process.env.TOMARI_NO_OAUTH_USAGE === "1") return () => {};
  let stopped = false;
  let lastFailure = "";
  const tick = async () => {
    const result = await fetchLimitsResult(source);
    if (stopped) return;
    if ("limits" in result) {
      lastFailure = "";
      hub.setLimits(result.limits);
    } else if (result.failure !== lastFailure) {
      lastFailure = result.failure; // said once per change, not every 5 minutes
      console.log(`oauth usage: ${result.failure}`);
    }
  };
  void tick();
  const timer = setInterval(tick, EVERY_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
