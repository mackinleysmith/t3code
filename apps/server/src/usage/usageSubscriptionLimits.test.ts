import type { UsageProviderLimits } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  awaitSubscriptionLimits,
  makeSubscriptionLimitsCacheEntry,
  normalizeClaudeSubscriptionLimits,
  normalizeCodexSubscriptionLimits,
  readSubscriptionLimitsCacheEntry,
  runSubscriptionLimitsProbe,
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

  it.effect("returns after five seconds while a slow provider probe keeps running", () =>
    Effect.gen(function* () {
      const limits = {
        provider: "codex",
        plan: "plus",
        windows: [
          {
            kind: "weekly",
            usedPercent: 42,
            resetsAt: null,
            unlimited: false,
          },
        ],
      } satisfies UsageProviderLimits;
      const providerFiber = yield* Effect.sleep(Duration.seconds(10)).pipe(
        Effect.as([limits] as readonly UsageProviderLimits[]),
        Effect.forkScoped,
      );
      const waitFiber = yield* awaitSubscriptionLimits(providerFiber).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(5));

      expect(yield* Fiber.join(waitFiber)).toEqual([]);

      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* Fiber.join(providerFiber)).toEqual([limits]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("distinguishes a successful empty response from a failed probe", () =>
    Effect.gen(function* () {
      const [emptyOutcome, failedOutcome] = yield* Effect.all([
        runSubscriptionLimitsProbe(Effect.succeed({}), () => null),
        runSubscriptionLimitsProbe(Effect.void, () => null),
      ]);

      expect(emptyOutcome).toEqual({ _tag: "Success", limits: null });
      expect(failedOutcome).toEqual({ _tag: "Failure" });
    }),
  );

  it("caches a successful empty response for three minutes", () => {
    const entry = makeSubscriptionLimitsCacheEntry({ _tag: "Success", limits: null }, 1_000);

    expect(readSubscriptionLimitsCacheEntry(entry, 180_999)).toEqual({
      _tag: "Success",
      limits: null,
    });
    expect(readSubscriptionLimitsCacheEntry(entry, 181_000)).toBeUndefined();
  });

  it("retries failed probes after a short backoff", () => {
    const entry = makeSubscriptionLimitsCacheEntry({ _tag: "Failure" }, 1_000);

    expect(readSubscriptionLimitsCacheEntry(entry, 5_999)).toEqual({ _tag: "Failure" });
    expect(readSubscriptionLimitsCacheEntry(entry, 6_000)).toBeUndefined();
  });
});
