import { describe, expect, test } from "bun:test";
import { liveLimits, parseStatusline } from "./usage.ts";

const ID = "933223df-5a0e-4983-bac6-49701b963989";
const NOW = 1_794_500_000_000;

/** The shape Claude Code 2.1.323 sent, trimmed to what Tomari reads. */
const payload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: ID,
    cost: { total_cost_usd: 0.0045 },
    context_window: { total_input_tokens: 46109, total_output_tokens: 25, used_percentage: 5 },
    rate_limits: {
      five_hour: { used_percentage: 44, resets_at: 1794576600 },
      seven_day: { used_percentage: 39, resets_at: 1794956400 },
    },
    ...extra,
  });

describe("parseStatusline", () => {
  test("reads usage and limits, turning reset times into epoch ms", () => {
    expect(parseStatusline(payload(), NOW)).toEqual({
      sessionId: ID,
      usage: { costUsd: 0.0045, contextPct: 5, inputTokens: 46109, outputTokens: 25 },
      limits: {
        fiveHour: { usedPct: 44, resetsAt: 1794576600_000 },
        sevenDay: { usedPct: 39, resetsAt: 1794956400_000 },
        updatedAt: NOW,
      },
    });
  });

  test("rejects anything that is not a JSON object with a valid session id", () => {
    for (const body of ["", "nope", "[]", "null", "42", JSON.stringify({ cost: {} }), JSON.stringify({ session_id: "../../etc" })]) {
      expect(parseStatusline(body, NOW)).toBeNull();
    }
  });

  test("a session billed by API key has no rate_limits: limits are null, usage still reads", () => {
    const reading = parseStatusline(payload({ rate_limits: undefined }), NOW)!;
    expect(reading.limits).toBeNull();
    expect(reading.usage.costUsd).toBe(0.0045);
  });

  test("each window can be absent on its own", () => {
    const reading = parseStatusline(payload({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1794576600 } } }), NOW)!;
    expect(reading.limits).toMatchObject({ fiveHour: { usedPct: 10 }, sevenDay: null });
  });

  test("a window missing a field, or with wrong types, is absent", () => {
    const rate_limits = { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: "9", resets_at: 1 } };
    expect(parseStatusline(payload({ rate_limits }), NOW)!.limits).toMatchObject({ fiveHour: null, sevenDay: null });
  });

  test("nulls and missing blocks become null fields, never a failure", () => {
    const reading = parseStatusline(JSON.stringify({ session_id: ID, cost: { total_cost_usd: null }, context_window: null }), NOW)!;
    expect(reading.usage).toEqual({ costUsd: null, contextPct: null, inputTokens: null, outputTokens: null });
  });

  test("percentages are clamped to 0-100 and counts to zero or more", () => {
    const reading = parseStatusline(
      payload({
        cost: { total_cost_usd: -1 },
        context_window: { total_input_tokens: -5, used_percentage: 250 },
        rate_limits: { five_hour: { used_percentage: -3, resets_at: 1 } },
      }),
      NOW,
    )!;
    expect(reading.usage).toMatchObject({ costUsd: 0, inputTokens: 0, contextPct: 100 });
    expect(reading.limits!.fiveHour!.usedPct).toBe(0);
  });
});

describe("liveLimits", () => {
  const limits = {
    fiveHour: { usedPct: 44, resetsAt: NOW + 1000 },
    sevenDay: { usedPct: 39, resetsAt: NOW + 5000 },
    updatedAt: NOW - 1,
  };

  test("keeps windows until their reset time", () => {
    expect(liveLimits(limits, NOW)).toEqual(limits);
  });

  test("drops a window once it has reset, and everything when none is left", () => {
    expect(liveLimits(limits, NOW + 2000)).toEqual({ ...limits, fiveHour: null });
    expect(liveLimits(limits, NOW + 5000)).toBeNull();
    expect(liveLimits(null, NOW)).toBeNull();
  });
});
