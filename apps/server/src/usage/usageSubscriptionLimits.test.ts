import type { UsageProviderLimits } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  awaitSubscriptionLimits,
  makeSubscriptionLimitsCacheEntry,
  makeSubscriptionLimitsDevFixture,
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
          label: "5h",
          usedPercent: 10.4,
          resetsAt: "2026-08-26T19:00:00.000Z",
          unlimited: false,
        },
        {
          kind: "weekly",
          label: "Week",
          usedPercent: 3,
          resetsAt: "2026-09-01T23:00:00.000Z",
          unlimited: false,
        },
      ],
    });
  });

  it("normalizes Claude's live model-scoped weekly window shape", () => {
    const limits = normalizeClaudeSubscriptionLimits({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: null,
        seven_day: { utilization: 3, resets_at: "2026-09-01T23:00:00.000Z" },
      },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 95,
          resets_at: "2026-09-01T23:00:00.000Z",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });

    expect(limits?.windows).toEqual([
      {
        kind: "weekly",
        label: "Week",
        usedPercent: 3,
        resetsAt: "2026-09-01T23:00:00.000Z",
        unlimited: false,
      },
      {
        kind: "weekly:fable",
        label: "Fable",
        usedPercent: 95,
        resetsAt: "2026-09-01T23:00:00.000Z",
        unlimited: false,
      },
    ]);
  });

  it("loosely normalizes future seven-day Claude windows", () => {
    const response = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: null,
        seven_day: null,
        seven_day_future_model: {
          utilization: 72,
          resets_at: "2026-09-01T23:00:00.000Z",
        },
      },
    } as Parameters<typeof normalizeClaudeSubscriptionLimits>[0];

    expect(normalizeClaudeSubscriptionLimits(response)?.windows).toEqual([
      {
        kind: "weekly:future_model",
        label: "Future Model",
        usedPercent: 72,
        resetsAt: "2026-09-01T23:00:00.000Z",
        unlimited: false,
      },
    ]);
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
          label: "5h",
          usedPercent: 42,
          resetsAt: "2026-08-29T10:40:00.000Z",
          unlimited: false,
        },
        { kind: "weekly", label: "Week", usedPercent: 8, resetsAt: null, unlimited: false },
      ],
    });
  });

  it("does not invent an unlimited window from the Codex plan name", () => {
    const limits = normalizeCodexSubscriptionLimits({
      rateLimits: {
        planType: "pro",
        secondary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: null },
      },
    });

    expect(limits?.windows).toEqual([
      { kind: "weekly", label: "Week", usedPercent: 44, resetsAt: null, unlimited: false },
    ]);
  });

  it("shows an unlimited Codex five-hour window only when the provider reports it", () => {
    const limits = normalizeCodexSubscriptionLimits({
      rateLimits: {
        planType: "pro",
        credits: { balance: null, hasCredits: false, unlimited: true },
        secondary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: null },
      },
    });

    expect(limits?.windows).toEqual([
      {
        kind: "fiveHour",
        label: "5h",
        usedPercent: 0,
        resetsAt: null,
        unlimited: true,
      },
      { kind: "weekly", label: "Week", usedPercent: 44, resetsAt: null, unlimited: false },
    ]);
  });

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

  it("backs off failed probes for ten minutes", () => {
    const entry = makeSubscriptionLimitsCacheEntry({ _tag: "Failure" }, 1_000);

    expect(readSubscriptionLimitsCacheEntry(entry, 600_999)).toEqual({ _tag: "Failure" });
    expect(readSubscriptionLimitsCacheEntry(entry, 601_000)).toBeUndefined();
  });

  it("provides representative limits only for the explicit dev fixture", () => {
    expect(makeSubscriptionLimitsDevFixture(false, "review", 1_788_000_000_000)).toBeNull();
    expect(makeSubscriptionLimitsDevFixture(true, undefined, 1_788_000_000_000)).toBeNull();

    expect(makeSubscriptionLimitsDevFixture(true, "review", 1_788_000_000_000)).toEqual([
      {
        provider: "codex",
        plan: "pro",
        windows: [
          {
            kind: "fiveHour",
            label: "5h",
            usedPercent: 0,
            resetsAt: null,
            unlimited: true,
          },
          {
            kind: "weekly",
            label: "Week",
            usedPercent: 47,
            resetsAt: "2026-09-04T10:40:00.000Z",
            unlimited: false,
          },
        ],
      },
      {
        provider: "claude",
        plan: "max",
        windows: [
          {
            kind: "fiveHour",
            label: "5h",
            usedPercent: 68,
            resetsAt: "2026-08-29T12:40:00.000Z",
            unlimited: false,
          },
          {
            kind: "weekly",
            label: "Week",
            usedPercent: 32,
            resetsAt: "2026-09-03T10:40:00.000Z",
            unlimited: false,
          },
          {
            kind: "weekly:fable",
            label: "Fable",
            usedPercent: 91,
            resetsAt: "2026-09-02T10:40:00.000Z",
            unlimited: false,
          },
        ],
      },
    ]);
  });
});
