import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  UsageLimitWindow,
  UsageLimitWindowKind,
  UsageProviderLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as CodexSchema from "effect-codex-app-server/schema";

const FIVE_HOURS_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const SUBSCRIPTION_LIMITS_READ_BUDGET_MS = 5_000;
export const SUBSCRIPTION_LIMITS_SUCCESS_TTL_MS = 3 * 60_000;
export const SUBSCRIPTION_LIMITS_FAILURE_TTL_MS = 10 * 60_000;

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

/** Tags provider responses so an empty response is distinct from a failed probe. */
export const runSubscriptionLimitsProbe = Effect.fn("runSubscriptionLimitsProbe")(
  <Response, Requirements>(
    probe: Effect.Effect<Response | undefined, never, Requirements>,
    normalize: (response: Response) => UsageProviderLimits | null,
  ) =>
    Effect.map(
      probe,
      (response): SubscriptionLimitsProbeOutcome =>
        response === undefined
          ? subscriptionLimitsProbeFailure
          : { _tag: "Success", limits: normalize(response) },
    ),
);

/** Bounds the page response without interrupting the service-owned probe fiber. */
export const awaitSubscriptionLimits = Effect.fn("awaitSubscriptionLimits")(
  (fiber: Fiber.Fiber<readonly UsageProviderLimits[], never>) =>
    Fiber.join(fiber).pipe(
      Effect.timeoutOption(SUBSCRIPTION_LIMITS_READ_BUDGET_MS),
      Effect.map(
        Option.match({
          onNone: (): readonly UsageProviderLimits[] => [],
          onSome: (limits) => limits,
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
> & {
  /** Newer Claude responses expose model-scoped weekly windows here. */
  readonly limits?: unknown;
};

type CodexUsageLimitsResponse = Pick<CodexSchema.V2GetAccountRateLimitsResponse, "rateLimits">;

function usedPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function claudeWindow(
  kind: UsageLimitWindowKind,
  label: string,
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
  return {
    kind,
    label,
    usedPercent: percent,
    resetsAt: window?.resets_at ?? null,
    unlimited: false,
  };
}

function readClaudeWindow(value: unknown): {
  readonly utilization: number | null;
  readonly resets_at: string | null;
} | null {
  if (!Predicate.isObject(value)) return null;
  const utilization = value.utilization;
  const resetsAt = value.resets_at;
  if (typeof utilization !== "number" && utilization !== null) return null;
  if (typeof resetsAt !== "string" && resetsAt !== null) return null;
  return { utilization, resets_at: resetsAt };
}

function formatClaudeWindowLabel(value: string): string {
  return value
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function readClaudeScopedWindows(value: unknown): readonly UsageLimitWindow[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((limit): readonly UsageLimitWindow[] => {
    if (!Predicate.isObject(limit) || limit.kind !== "weekly_scoped") return [];
    const scope = limit.scope;
    if (!Predicate.isObject(scope) || !Predicate.isObject(scope.model)) return [];
    const label = scope.model.display_name;
    if (typeof label !== "string" || label.trim().length === 0) return [];
    const resetsAt = limit.resets_at;
    if (typeof resetsAt !== "string" && resetsAt !== null) return [];
    const percent = typeof limit.percent === "number" ? usedPercent(limit.percent) : null;
    if (percent === null) return [];

    const normalizedLabel = label.trim();
    return [
      {
        kind: `weekly:${normalizedLabel.toLowerCase()}`,
        label: normalizedLabel,
        usedPercent: percent,
        resetsAt,
        unlimited: false,
      },
    ];
  });
}

export function normalizeClaudeSubscriptionLimits(
  response: ClaudeUsageLimitsResponse | undefined,
): UsageProviderLimits | null {
  const rateLimits = response?.rate_limits;
  if (!response?.rate_limits_available || rateLimits === null || rateLimits === undefined)
    return null;

  const windows = [
    claudeWindow("fiveHour", "5h", rateLimits.five_hour),
    claudeWindow("weekly", "Week", rateLimits.seven_day),
  ].filter((window): window is UsageLimitWindow => window !== null);

  const scopedWindows = new Map<string, UsageLimitWindow>();
  if (Predicate.isObject(rateLimits)) {
    for (const [key, value] of Object.entries(rateLimits)) {
      if (!key.startsWith("seven_day_") || key === "seven_day") continue;
      const window = readClaudeWindow(value);
      if (window === null) continue;
      const suffix = key.slice("seven_day_".length);
      const label = formatClaudeWindowLabel(suffix);
      if (label.length === 0) continue;
      const normalized = claudeWindow(`weekly:${suffix}`, label, window);
      if (normalized !== null) scopedWindows.set(label.toLowerCase(), normalized);
    }
  }
  const limits =
    response.limits ??
    (Predicate.hasProperty(rateLimits, "limits") ? rateLimits.limits : undefined);
  for (const window of readClaudeScopedWindows(limits)) {
    scopedWindows.set(window.label?.toLowerCase() ?? window.kind, window);
  }
  windows.push(...scopedWindows.values());
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
    label: codexWindowKind(window, fallback) === "fiveHour" ? "5h" : "Week",
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
    response.rateLimits.credits?.unlimited === true &&
    !meteredWindows.some((window) => window.kind === "fiveHour");
  const windows = unlimitedFiveHour
    ? [
        {
          kind: "fiveHour",
          label: "5h",
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

/** Provides representative quota data for visual review without provider authentication. */
export function makeSubscriptionLimitsDevFixture(
  enabled: boolean,
  fixture: string | undefined,
  nowMs: number,
): readonly UsageProviderLimits[] | null {
  if (!enabled || fixture !== "review") return null;

  const claude = normalizeClaudeSubscriptionLimits({
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization: 68,
        resets_at: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 2 * HOUR_MS)),
      },
      seven_day: {
        utilization: 32,
        resets_at: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 5 * DAY_MS)),
      },
    },
    limits: [
      {
        kind: "weekly_scoped",
        percent: 91,
        resets_at: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 4 * DAY_MS)),
        scope: { model: { display_name: "Fable" } },
      },
    ],
  });
  const codex = normalizeCodexSubscriptionLimits({
    rateLimits: {
      planType: "pro",
      credits: { balance: null, hasCredits: false, unlimited: true },
      secondary: {
        usedPercent: 47,
        windowDurationMins: WEEK_MINUTES,
        resetsAt: Math.floor((nowMs + 6 * DAY_MS) / 1_000),
      },
    },
  });

  return [codex, claude].filter((limits): limits is UsageProviderLimits => limits !== null);
}
