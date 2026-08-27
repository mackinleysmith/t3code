// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatRelativeHourShort,
  formatUsageObservationAge,
  formatUsageResetCountdown,
  formatUsageResetDateTime,
  makeWindow,
} from "./usageFormat.ts";

describe("hourly usage formatting", () => {
  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});

describe("subscription reset formatting", () => {
  const now = Date.parse("2026-08-26T17:00:00.000Z");

  it("keeps short windows precise to the minute", () => {
    expect(formatUsageResetCountdown("2026-08-26T19:14:00.000Z", now)).toBe("2h 14m");
    expect(formatUsageResetCountdown("2026-08-26T17:00:01.000Z", now)).toBe("1m");
  });

  it("keeps weekly windows compact", () => {
    expect(formatUsageResetCountdown("2026-08-29T21:00:00.000Z", now)).toBe("3d 4h");
    expect(formatUsageResetCountdown("2026-08-29T17:45:00.000Z", now)).toBe("3d");
  });

  it("handles reached and invalid reset times", () => {
    expect(formatUsageResetCountdown("2026-08-26T17:00:00.000Z", now)).toBe("now");
    expect(formatUsageResetCountdown("not-a-date", now)).toBeNull();
  });

  it("formats an exact reset time without throwing on malformed provider data", () => {
    expect(formatUsageResetDateTime("2026-08-26T19:14:00.000Z", "UTC")).toBe("Aug 26, 7:14 PM");
    expect(formatUsageResetDateTime("not-a-date", "UTC")).toBeNull();
    expect(formatUsageResetDateTime("2026-08-26T19:14:00.000Z", "Etc/Unknown")).toBeNull();
  });

  it("formats the age of a retained subscription-limit snapshot", () => {
    expect(formatUsageObservationAge("2026-08-26T16:55:00.000Z", now)).toBe("5m");
    expect(formatUsageObservationAge("2026-08-26T14:00:00.000Z", now)).toBe("3h");
    expect(formatUsageObservationAge("not-a-date", now)).toBeNull();
  });
});
