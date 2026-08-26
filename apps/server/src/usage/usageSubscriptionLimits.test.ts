import { describe, expect, it } from "vite-plus/test";

import {
  normalizeClaudeSubscriptionLimits,
  normalizeCodexSubscriptionLimits,
} from "./usageSubscriptionLimits.ts";

describe("subscription usage limits", () => {
  it("normalizes Claude's five-hour and weekly windows", () => {
    const limits = normalizeClaudeSubscriptionLimits({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 10.4, resets_at: "2026-08-26T19:00:00.000Z" },
        seven_day: { utilization: 3, resets_at: "2026-09-01T23:00:00.000Z" },
      },
    });

    expect(limits).toEqual({
      provider: "claude",
      plan: "max",
      windows: [
        {
          kind: "fiveHour",
          usedPercent: 10.4,
          resetsAt: "2026-08-26T19:00:00.000Z",
          unlimited: false,
        },
        {
          kind: "weekly",
          usedPercent: 3,
          resetsAt: "2026-09-01T23:00:00.000Z",
          unlimited: false,
        },
      ],
    });
  });

  it("omits Claude limits when plan rate limits are unavailable", () => {
    expect(
      normalizeClaudeSubscriptionLimits({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      }),
    ).toBeNull();
  });

  it("omits Claude limits when the experimental response has no rate-limit payload", () => {
    expect(
      normalizeClaudeSubscriptionLimits({
        subscription_type: "max",
        rate_limits_available: true,
      }),
    ).toBeNull();
  });

  it("normalizes Codex windows and Unix reset timestamps", () => {
    const limits = normalizeCodexSubscriptionLimits({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_788_000_000 },
        secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: null },
      },
    });

    expect(limits).toEqual({
      provider: "codex",
      plan: "plus",
      windows: [
        {
          kind: "fiveHour",
          usedPercent: 42,
          resetsAt: "2026-08-29T10:40:00.000Z",
          unlimited: false,
        },
        { kind: "weekly", usedPercent: 8, resetsAt: null, unlimited: false },
      ],
    });
  });

  it.each(["pro", "prolite"] as const)(
    "marks a missing five-hour window as unlimited for the %s plan",
    (planType) => {
      const limits = normalizeCodexSubscriptionLimits({
        rateLimits: {
          planType,
          secondary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: null },
        },
      });

      expect(limits?.windows).toEqual([
        {
          kind: "fiveHour",
          usedPercent: 0,
          resetsAt: null,
          unlimited: true,
        },
        { kind: "weekly", usedPercent: 44, resetsAt: null, unlimited: false },
      ]);
    },
  );

  it("clamps provider percentages to the progress bar range", () => {
    const limits = normalizeCodexSubscriptionLimits({
      rateLimits: {
        primary: { usedPercent: 140 },
        secondary: { usedPercent: -5 },
      },
    });

    expect(limits?.windows.map((window) => window.usedPercent)).toEqual([100, 0]);
  });
});
