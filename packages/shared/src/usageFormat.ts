// @effect-diagnostics globalDate:off -- Usage windows are calendar days in the viewer's zone, derived from wall-clock "now" via Intl.
/**
 * Display formatting for the usage page.
 *
 * @module usageFormat
 */
import { UsageDay, type UsageResolution, type UsageSummaryInput } from "@t3tools/contracts";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");
const MINUTE_MS = 60 * 1000;

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

/**
 * Compacts a token count to three significant figures with a unit suffix, so
 * columns of numbers line up at a glance (`19.9B`, `76.7M`, `804K`).
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

/** Compact time remaining for subscription-limit reset labels. */
export function formatUsageResetCountdown(resetsAt: string, nowMs: number): string | null {
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;

  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return "now";

  const totalMinutes = Math.ceil(remainingMs / MINUTE_MS);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Compact age for a last-known-good subscription-limit snapshot. */
export function formatUsageObservationAge(observedAt: string, nowMs: number): string | null {
  const observedAtMs = Date.parse(observedAt);
  if (Number.isNaN(observedAtMs)) return null;

  const totalMinutes = Math.max(0, Math.floor((nowMs - observedAtMs) / MINUTE_MS));
  if (totalMinutes < 1) return "less than a minute";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

/** Exact reset instant for subscription-limit details, including minutes. */
export function formatUsageResetDateTime(instant: string, timeZone?: string): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...(timeZone === undefined ? {} : { timeZone }),
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return null;
  }
}

/** `2026-08-07` to `Aug 7`. */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) return day;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}

/** Inclusive day list between two `YYYY-MM-DD` bounds. */
export function enumerateDays(sinceDay: string, untilDay: string): readonly string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;

  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

const HOUR_MS = 60 * 60 * 1000;

/** Every fixed-duration bucket start in an hourly rolling window. */
export function enumerateHourStarts(sinceTime: string, untilTime: string): readonly string[] {
  const starts: string[] = [];
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return starts;

  for (let cursor = start; cursor < end; cursor += HOUR_MS) {
    starts.push(new Date(cursor).toISOString());
  }
  return starts;
}

/**
 * A rolling bucket start rendered in the viewer's requested time zone.
 *
 * Repeated wall-clock hours during a fall-back transition include their short
 * zone name so the two distinct buckets remain distinguishable.
 */
export function formatHourShort(hourStart: string, timeZone?: string): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const options = timeZone === undefined ? {} : { timeZone };
  const hourFormat = new Intl.DateTimeFormat("en-US", {
    ...options,
    hour: "numeric",
  });
  const wallHourFormat = new Intl.DateTimeFormat("en-CA", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const wallHour = wallHourFormat.format(instant);
  const isRepeatedHour = [-HOUR_MS, HOUR_MS].some(
    (offset) => wallHourFormat.format(new Date(instant.getTime() + offset)) === wallHour,
  );

  if (!isRepeatedHour) return hourFormat.format(instant);
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: "numeric",
    timeZoneName: "short",
  }).format(instant);
}

/** `2026-08-11T14:37:00Z` to `Aug 11, 2 PM` in the requested zone. */
export function formatDateTimeShort(instant: string, timeZone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(date);
}

/** An hourly tooltip label relative to the rolling window's end date. */
export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
): string {
  const instant = new Date(hourStart);
  const reference = new Date(relativeTo);
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) {
    return formatDateTimeShort(hourStart, timeZone);
  }

  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const instantDay = Date.parse(`${dayFormat.format(instant)}T00:00:00Z`);
  const referenceDay = Date.parse(`${dayFormat.format(reference)}T00:00:00Z`);
  const calendarDaysAgo = Math.round((referenceDay - instantDay) / (24 * HOUR_MS));
  const hour = formatHourShort(hourStart, timeZone);

  if (calendarDaysAgo === 0) return `${hour} today`;
  if (calendarDaysAgo === 1) return `${hour} yesterday`;
  return formatDateTimeShort(hourStart, timeZone);
}

/**
 * The window the page requests, expressed in the viewer's own time zone so days
 * line up with what they actually experienced.
 */
export function makeWindow(
  days: number,
  now = new Date(),
  resolution: UsageResolution = "day",
): UsageSummaryInput {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than crash the page.
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const untilDay = format.format(now);
  if (resolution === "hour") {
    // Minute-aligned bounds keep labels readable while still representing an
    // exact rolling 24-hour duration. Fixed-duration buckets remain correct
    // across offset changes and daylight-saving transitions.
    const untilTimeMs = Math.floor(now.getTime() / 60_000) * 60_000;
    const sinceTimeMs = untilTimeMs - 24 * HOUR_MS;
    const sinceTime = new Date(sinceTimeMs);
    const untilTime = new Date(untilTimeMs);
    return {
      sinceDay: UsageDay.make(format.format(sinceTime)),
      untilDay: UsageDay.make(format.format(untilTime)),
      timeZone,
      resolution,
      sinceTime: sinceTime.toISOString(),
      untilTime: untilTime.toISOString(),
    };
  }
  // Subtracting fixed milliseconds from `now` lands on the wrong calendar day
  // around a DST transition. The window start is pure calendar arithmetic on
  // the local end day, done in UTC where days are uniform.
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
  return {
    sinceDay: UsageDay.make(start.toISOString().slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    resolution,
  };
}
