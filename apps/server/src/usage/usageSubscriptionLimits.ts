import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  UsageLimitWindow,
  UsageLimitWindowKind,
  UsageProviderKind,
  UsageProviderLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const FIVE_HOURS_MINUTES = 5 * 60;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * 24 * 60;
const MONTH_MINUTES = 30 * DAY_MINUTES;
const YEAR_MINUTES = 365 * DAY_MINUTES;
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
  readonly lastSuccess?: {
    readonly limits: UsageProviderLimits | null;
    readonly observedAtMs: number;
  };
}

export interface SubscriptionLimitsCacheIdentity {
  readonly provider: UsageProviderKind;
  readonly binaryPath: string;
  readonly homePath: string;
  readonly launchArgs?: string;
}

/** Keeps cached quota data scoped to the provider runtime and account home that produced it. */
export function makeSubscriptionLimitsCacheKey(identity: SubscriptionLimitsCacheIdentity): string {
  return JSON.stringify([
    identity.provider,
    identity.binaryPath,
    identity.homePath,
    identity.launchArgs ?? null,
  ]);
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

/** Returns ready limits immediately, otherwise gives the background refresh a short budget. */
export const awaitSubscriptionLimits = Effect.fn("awaitSubscriptionLimits")(function* (
  refreshFiber: Fiber.Fiber<void, never>,
  readCurrent: Effect.Effect<readonly UsageProviderLimits[], never>,
) {
  const ready = yield* readCurrent;
  if (ready.length > 0) return ready;

  yield* Fiber.join(refreshFiber).pipe(
    Effect.timeoutOption(SUBSCRIPTION_LIMITS_READ_BUDGET_MS),
    Effect.asVoid,
  );
  return yield* readCurrent;
});

export function makeSubscriptionLimitsCacheEntry(
  outcome: SubscriptionLimitsProbeOutcome,
  nowMs: number,
  previous?: SubscriptionLimitsCacheEntry,
  observedAtMs = nowMs,
): SubscriptionLimitsCacheEntry {
  const ttlMs =
    outcome._tag === "Success"
      ? SUBSCRIPTION_LIMITS_SUCCESS_TTL_MS
      : SUBSCRIPTION_LIMITS_FAILURE_TTL_MS;
  const expiresAtMs =
    outcome._tag === "Success" ? Math.min(nowMs + ttlMs, observedAtMs + ttlMs) : nowMs + ttlMs;
  const lastSuccess =
    outcome._tag === "Success" ? { limits: outcome.limits, observedAtMs } : previous?.lastSuccess;
  return {
    expiresAtMs,
    outcome,
    ...(lastSuccess === undefined ? {} : { lastSuccess }),
  };
}

export function readSubscriptionLimitsCacheEntry(
  entry: SubscriptionLimitsCacheEntry | undefined,
  nowMs: number,
): SubscriptionLimitsProbeOutcome | undefined {
  if (entry === undefined || nowMs >= entry.expiresAtMs) return undefined;
  if (entry.outcome._tag === "Success") {
    return {
      _tag: "Success",
      limits: stampSubscriptionLimits(entry.outcome.limits, entry.lastSuccess?.observedAtMs, false),
    };
  }
  if (entry.lastSuccess === undefined) return entry.outcome;
  return {
    _tag: "Success",
    limits: stampSubscriptionLimits(entry.lastSuccess.limits, entry.lastSuccess.observedAtMs, true),
  };
}

/** Probe failures back off subprocesses but must not suppress free local recovery. */
export function shouldReadCodexTranscriptSnapshot(
  entry: SubscriptionLimitsCacheEntry | undefined,
  nowMs: number,
): boolean {
  return (
    entry?.outcome._tag === "Failure" ||
    readSubscriptionLimitsCacheEntry(entry, nowMs) === undefined
  );
}

function stampSubscriptionLimits(
  limits: UsageProviderLimits | null,
  observedAtMs: number | undefined,
  stale: boolean,
): UsageProviderLimits | null {
  if (limits === null || observedAtMs === undefined) return limits;
  return {
    ...limits,
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(observedAtMs)),
    stale,
  };
}

type ClaudeUsageLimitsResponse = Partial<
  Pick<SDKControlGetUsageResponse, "subscription_type" | "rate_limits_available" | "rate_limits">
> & {
  /** Compatibility fallback for SDK builds that project model-scoped limits at the top level. */
  readonly limits?: unknown;
};

interface CodexRateLimitWindowResponse {
  readonly usedPercent: number;
  readonly windowDurationMins?: number | null;
  readonly resetsAt?: number | null;
}

export interface CodexUsageLimitsResponse {
  readonly rateLimits: {
    readonly planType?: string | null;
    readonly primary?: CodexRateLimitWindowResponse | null;
    readonly secondary?: CodexRateLimitWindowResponse | null;
  };
}

export interface CodexTranscriptRateLimitsSnapshot {
  readonly observedAtMs: number;
  readonly response: CodexUsageLimitsResponse;
}

const NullableNumber = Schema.Union([Schema.Number, Schema.Null]);
const CodexTranscriptRateLimitWindow = Schema.Struct({
  used_percent: Schema.Number,
  window_minutes: Schema.optionalKey(NullableNumber),
  resets_at: Schema.optionalKey(NullableNumber),
});
const CodexTranscriptRateLimitsEvent = Schema.Struct({
  timestamp: Schema.String,
  payload: Schema.Struct({
    type: Schema.Literal("token_count"),
    info: Schema.Struct({
      rate_limits: Schema.Struct({
        primary: Schema.optionalKey(Schema.Union([CodexTranscriptRateLimitWindow, Schema.Null])),
        secondary: Schema.optionalKey(Schema.Union([CodexTranscriptRateLimitWindow, Schema.Null])),
        plan_type: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
      }),
    }),
  }),
});
const decodeCodexTranscriptRateLimitsEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexTranscriptRateLimitsEvent),
);

function codexTranscriptWindow(
  window: typeof CodexTranscriptRateLimitWindow.Type | null | undefined,
): CodexRateLimitWindowResponse | null | undefined {
  if (window === null || window === undefined) return window;
  return {
    usedPercent: window.used_percent,
    ...(window.window_minutes === undefined ? {} : { windowDurationMins: window.window_minutes }),
    ...(window.resets_at === undefined ? {} : { resetsAt: window.resets_at }),
  };
}

/** Reads the account-accurate rate-limit snapshot Codex persists after a turn. */
export function parseCodexTranscriptRateLimitsSnapshot(
  line: string,
): CodexTranscriptRateLimitsSnapshot | null {
  const decoded = decodeCodexTranscriptRateLimitsEvent(line);
  if (Option.isNone(decoded)) return null;
  const observedAtMs = Date.parse(decoded.value.timestamp);
  if (!Number.isFinite(observedAtMs)) return null;
  const limits = decoded.value.payload.info.rate_limits;
  const primary = codexTranscriptWindow(limits.primary);
  const secondary = codexTranscriptWindow(limits.secondary);
  return {
    observedAtMs,
    response: {
      rateLimits: {
        ...(limits.plan_type === undefined ? {} : { planType: limits.plan_type }),
        ...(primary === undefined ? {} : { primary }),
        ...(secondary === undefined ? {} : { secondary }),
      },
    },
  };
}

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

interface CodexWindowPresentation {
  readonly kind: UsageLimitWindowKind;
  readonly label: string;
}

const CODEX_WINDOW_PRESENTATIONS = [
  { minutes: FIVE_HOURS_MINUTES, kind: "fiveHour", label: "5h" },
  { minutes: DAY_MINUTES, kind: "daily", label: "Day" },
  { minutes: WEEK_MINUTES, kind: "weekly", label: "Week" },
  { minutes: MONTH_MINUTES, kind: "monthly", label: "Month" },
  { minutes: YEAR_MINUTES, kind: "annual", label: "Year" },
] as const;

function isApproximateCodexWindow(actualMinutes: number, expectedMinutes: number): boolean {
  return actualMinutes >= expectedMinutes * 0.95 && actualMinutes <= expectedMinutes * 1.05;
}

function codexWindowPresentation(
  window: CodexRateLimitWindowResponse,
  position: "primary" | "secondary",
): CodexWindowPresentation {
  const duration = window.windowDurationMins;
  if (duration !== null && duration !== undefined && Number.isFinite(duration)) {
    const known = CODEX_WINDOW_PRESENTATIONS.find((candidate) =>
      isApproximateCodexWindow(duration, candidate.minutes),
    );
    if (known !== undefined) return known;
  }
  return {
    kind: `codex:${position}`,
    label: position === "primary" ? "Usage" : "Secondary",
  };
}

function codexWindow(
  window: CodexRateLimitWindowResponse | null | undefined,
  position: "primary" | "secondary",
): UsageLimitWindow | null {
  if (!window) return null;
  const percent = usedPercent(window.usedPercent);
  if (percent === null) return null;

  const resetsAt =
    window.resetsAt === null || window.resetsAt === undefined
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1_000));
  const presentation = codexWindowPresentation(window, position);
  return {
    kind: presentation.kind,
    label: presentation.label,
    usedPercent: percent,
    resetsAt,
  };
}

export function normalizeCodexSubscriptionLimits(
  response: CodexUsageLimitsResponse | undefined,
): UsageProviderLimits | null {
  if (!response) return null;

  const meteredWindows = [
    codexWindow(response.rateLimits.primary, "primary"),
    codexWindow(response.rateLimits.secondary, "secondary"),
  ].filter((window): window is UsageLimitWindow => window !== null);
  if (meteredWindows.length === 0) return null;

  const plan = response.rateLimits.planType?.trim() ?? "";
  return {
    provider: "codex",
    plan: plan.length > 0 ? plan : null,
    windows: meteredWindows,
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
      secondary: {
        usedPercent: 47,
        windowDurationMins: WEEK_MINUTES,
        resetsAt: Math.floor((nowMs + 6 * DAY_MS) / 1_000),
      },
    },
  });

  return [codex, claude].filter((limits): limits is UsageProviderLimits => limits !== null);
}
