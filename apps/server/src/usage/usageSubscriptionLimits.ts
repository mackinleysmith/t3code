import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  UsageLimitWindow,
  UsageLimitWindowKind,
  UsageProviderLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as CodexSchema from "effect-codex-app-server/schema";

const FIVE_HOURS_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;
const UNLIMITED_CODEX_FIVE_HOUR_PLANS = new Set(["pro", "prolite"]);

export const SUBSCRIPTION_LIMITS_PROBE_TIMEOUT_MS = 5_000;
export const SUBSCRIPTION_LIMITS_SUCCESS_TTL_MS = 60_000;
export const SUBSCRIPTION_LIMITS_FAILURE_TTL_MS = 5_000;

export type SubscriptionLimitsProbeOutcome =
  | {
      readonly _tag: "Success";
      readonly limits: UsageProviderLimits | null;
    }
  | { readonly _tag: "Failure" };

export interface SubscriptionLimitsCacheEntry {
  readonly expiresAtMs: number;
  readonly outcome: SubscriptionLimitsProbeOutcome;
}

const subscriptionLimitsProbeFailure = { _tag: "Failure" } as const;

/** Caps optional provider probes and preserves successful empty responses. */
export const runSubscriptionLimitsProbe = Effect.fn("runSubscriptionLimitsProbe")(
  <Response, Requirements>(
    probe: Effect.Effect<Response | undefined, never, Requirements>,
    normalize: (response: Response) => UsageProviderLimits | null,
  ) =>
    probe.pipe(
      Effect.map(
        (response): SubscriptionLimitsProbeOutcome =>
          response === undefined
            ? subscriptionLimitsProbeFailure
            : { _tag: "Success", limits: normalize(response) },
      ),
      Effect.timeoutOption(SUBSCRIPTION_LIMITS_PROBE_TIMEOUT_MS),
      Effect.map(
        Option.match({
          onNone: () => subscriptionLimitsProbeFailure,
          onSome: (outcome) => outcome,
        }),
      ),
    ),
);

export function makeSubscriptionLimitsCacheEntry(
  outcome: SubscriptionLimitsProbeOutcome,
  nowMs: number,
): SubscriptionLimitsCacheEntry {
  const ttlMs =
    outcome._tag === "Success"
      ? SUBSCRIPTION_LIMITS_SUCCESS_TTL_MS
      : SUBSCRIPTION_LIMITS_FAILURE_TTL_MS;
  return { expiresAtMs: nowMs + ttlMs, outcome };
}

export function readSubscriptionLimitsCacheEntry(
  entry: SubscriptionLimitsCacheEntry | undefined,
  nowMs: number,
): SubscriptionLimitsProbeOutcome | undefined {
  return entry !== undefined && nowMs < entry.expiresAtMs ? entry.outcome : undefined;
}

type ClaudeUsageLimitsResponse = Partial<
  Pick<SDKControlGetUsageResponse, "subscription_type" | "rate_limits_available" | "rate_limits">
>;

type CodexUsageLimitsResponse = Pick<CodexSchema.V2GetAccountRateLimitsResponse, "rateLimits">;

function usedPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function claudeWindow(
  kind: UsageLimitWindowKind,
  window:
    | {
        readonly utilization: number | null;
        readonly resets_at: string | null;
      }
    | null
    | undefined,
): UsageLimitWindow | null {
  const percent = usedPercent(window?.utilization ?? null);
  if (percent === null) return null;
  return { kind, usedPercent: percent, resetsAt: window?.resets_at ?? null, unlimited: false };
}

export function normalizeClaudeSubscriptionLimits(
  response: ClaudeUsageLimitsResponse | undefined,
): UsageProviderLimits | null {
  const rateLimits = response?.rate_limits;
  if (!response?.rate_limits_available || rateLimits === null || rateLimits === undefined)
    return null;

  const windows = [
    claudeWindow("fiveHour", rateLimits.five_hour),
    claudeWindow("weekly", rateLimits.seven_day),
  ].filter((window): window is UsageLimitWindow => window !== null);
  if (windows.length === 0) return null;

  const plan = response.subscription_type?.trim() ?? "";
  return {
    provider: "claude",
    plan: plan.length > 0 ? plan : null,
    windows,
  };
}

function codexWindowKind(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow,
  fallback: UsageLimitWindowKind,
): UsageLimitWindowKind {
  if (window.windowDurationMins === FIVE_HOURS_MINUTES) return "fiveHour";
  if (window.windowDurationMins === WEEK_MINUTES) return "weekly";
  return fallback;
}

function codexWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
  fallback: UsageLimitWindowKind,
): UsageLimitWindow | null {
  if (!window) return null;
  const percent = usedPercent(window.usedPercent);
  if (percent === null) return null;

  const resetsAt =
    window.resetsAt === null || window.resetsAt === undefined
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1_000));
  return {
    kind: codexWindowKind(window, fallback),
    usedPercent: percent,
    resetsAt,
    unlimited: false,
  };
}

export function normalizeCodexSubscriptionLimits(
  response: CodexUsageLimitsResponse | undefined,
): UsageProviderLimits | null {
  if (!response) return null;

  const meteredWindows = [
    codexWindow(response.rateLimits.primary, "fiveHour"),
    codexWindow(response.rateLimits.secondary, "weekly"),
  ].filter((window): window is UsageLimitWindow => window !== null);
  const unlimitedFiveHour =
    response.rateLimits.planType !== null &&
    response.rateLimits.planType !== undefined &&
    UNLIMITED_CODEX_FIVE_HOUR_PLANS.has(response.rateLimits.planType) &&
    !meteredWindows.some((window) => window.kind === "fiveHour");
  const windows = unlimitedFiveHour
    ? [
        {
          kind: "fiveHour",
          usedPercent: 0,
          resetsAt: null,
          unlimited: true,
        } satisfies UsageLimitWindow,
        ...meteredWindows,
      ]
    : meteredWindows;
  if (windows.length === 0) return null;

  return {
    provider: "codex",
    plan: response.rateLimits.planType ?? null,
    windows,
  };
}
