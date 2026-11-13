import { describe, expect, test } from "bun:test";
import { fetchLimits, parseOauthUsage, tokenFrom, USAGE_URL } from "./oauth-usage.ts";

const creds = (extra: Record<string, unknown> = {}) => JSON.stringify({ claudeAiOauth: { accessToken: "tok-123", expiresAt: 5_000, ...extra } });

describe("tokenFrom", () => {
  test("returns the access token while it is valid", () => {
    expect(tokenFrom(creds(), 1_000)).toBe("tok-123");
  });
  test("refuses expired, missing or malformed credentials", () => {
    expect(tokenFrom(creds(), 6_000)).toBeNull();
    expect(tokenFrom(creds({ accessToken: "" }), 1_000)).toBeNull();
    expect(tokenFrom("{}", 1_000)).toBeNull();
    expect(tokenFrom("nope", 1_000)).toBeNull();
  });
});

describe("parseOauthUsage", () => {
  test("reads utilization and ISO reset times, and tolerates absent windows", () => {
    const limits = parseOauthUsage(
      { five_hour: { utilization: 35, resets_at: "2026-11-13T15:00:00+00:00" }, seven_day: null, extra_usage: {} },
      42,
    );
    expect(limits).toEqual({ fiveHour: { usedPct: 35, resetsAt: Date.parse("2026-11-13T15:00:00Z") }, sevenDay: null, updatedAt: 42 });
  });
  test("a window with no reset time but something used is ignored, not guessed", () => {
    expect(parseOauthUsage({ five_hour: { utilization: 48, resets_at: null }, seven_day: { utilization: 3, resets_at: "2026-11-20T00:00:00Z" } }, 1)!.fiveHour).toBeNull();
  });
  test("a window with no reset time is nothing used and already reset", () => {
    expect(parseOauthUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: null }, 7)).toEqual({
      fiveHour: { usedPct: 0, resetsAt: 0 },
      sevenDay: null,
      updatedAt: 7,
    });
  });
  test("clamps the percentage and drops unusable windows; null when nothing is left", () => {
    expect(parseOauthUsage({ five_hour: { utilization: 250, resets_at: "2026-11-13T15:00:00Z" } }, 0)!.fiveHour!.usedPct).toBe(100);
    expect(parseOauthUsage({ five_hour: { utilization: 5, resets_at: "x" }, seven_day: { utilization: "5" } }, 0)).toBeNull();
    expect(parseOauthUsage(null, 0)).toBeNull();
  });
});

describe("fetchLimits", () => {
  const body = { five_hour: { utilization: 10, resets_at: "2026-11-13T15:00:00Z" } };
  const source = (respond: () => Response | Promise<Response>, seen: { url?: string; auth?: string } = {}) => ({
    credentials: async () => creds(),
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.auth = (init.headers as Record<string, string>).Authorization;
      return respond();
    }) as unknown as typeof fetch,
    now: () => 1_000,
  });

  test("sends the token to the usage endpoint and returns the limits", async () => {
    const seen: { url?: string; auth?: string } = {};
    const limits = await fetchLimits(source(() => Response.json(body), seen));
    expect(seen).toEqual({ url: USAGE_URL, auth: "Bearer tok-123" });
    expect(limits!.fiveHour!.usedPct).toBe(10);
  });
  test("any failure is null: HTTP error, network error, no credentials", async () => {
    expect(await fetchLimits(source(() => new Response("no", { status: 401 })))).toBeNull();
    expect(await fetchLimits(source(() => Promise.reject(new Error("offline"))))).toBeNull();
    expect(await fetchLimits({ ...source(() => Response.json(body)), credentials: async () => null })).toBeNull();
  });
});
