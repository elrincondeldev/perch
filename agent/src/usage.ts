/**
 * Reads the JSON Claude Code pipes to a statusline command. Pure: no I/O, the caller passes the clock.
 * The shape is Claude Code's, so every field is optional and untrusted: anything unexpected becomes null.
 */
import type { AccountLimits, LimitWindow, SessionUsage } from "../../shared/protocol.ts";
import { isSessionId } from "./protocol-guard.ts";

export interface StatuslineReading {
  sessionId: string;
  usage: SessionUsage;
  /** Null when this reading has no `rate_limits` at all, e.g. a session billed by API key. */
  limits: AccountLimits | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.min(100, Math.max(0, n));
}

function nonNegative(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.max(0, n);
}

/** `resets_at` is epoch seconds. A window without both fields is treated as absent. */
function limitWindow(value: unknown): LimitWindow | null {
  if (!isObject(value)) return null;
  const usedPct = percent(value.used_percentage);
  const resetsAt = num(value.resets_at);
  return usedPct === null || resetsAt === null ? null : { usedPct, resetsAt: resetsAt * 1000 };
}

/** Null unless `body` is a JSON object with a valid `session_id`. */
export function parseStatusline(body: string, now: number): StatuslineReading | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(data) || !isSessionId(data.session_id)) return null;

  const cost = isObject(data.cost) ? data.cost : {};
  const context = isObject(data.context_window) ? data.context_window : {};
  const usage: SessionUsage = {
    costUsd: nonNegative(cost.total_cost_usd),
    contextPct: percent(context.used_percentage),
    inputTokens: nonNegative(context.total_input_tokens),
    outputTokens: nonNegative(context.total_output_tokens),
  };

  let limits: AccountLimits | null = null;
  if (isObject(data.rate_limits)) {
    limits = {
      fiveHour: limitWindow(data.rate_limits.five_hour),
      sevenDay: limitWindow(data.rate_limits.seven_day),
      updatedAt: now,
    };
  }
  return { sessionId: data.session_id, usage, limits };
}

/** Drops a window once its reset time has passed, as Claude Code does; null when nothing is left. */
export function liveLimits(limits: AccountLimits | null, now: number): AccountLimits | null {
  if (!limits) return null;
  const alive = (w: LimitWindow | null) => (w && w.resetsAt > now ? w : null);
  const fiveHour = alive(limits.fiveHour);
  const sevenDay = alive(limits.sevenDay);
  return fiveHour || sevenDay ? { ...limits, fiveHour, sevenDay } : null;
}
