// @effect-diagnostics nodeBuiltinImport:off -- This focused test exercises the raw Node transcript tail reader.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { readFreshCodexRateLimitsSnapshot } from "./usageTranscriptReader.ts";

function rateLimitLine(timestamp: string, usedPercent: number): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        rate_limits: {
          primary: null,
          secondary: {
            used_percent: usedPercent,
            window_minutes: 10_080,
            resets_at: 1_788_000_000,
          },
          plan_type: "prolite",
        },
      },
    },
  });
}

describe("Codex transcript rate-limit snapshots", () => {
  it("returns the newest fresh snapshot from a recently modified rollout", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-codex-limits-"));
    try {
      const path = NodePath.join(directory, "rollout.jsonl");
      const olderAt = "2026-08-27T02:09:00.000Z";
      const newerAt = "2026-08-27T02:10:00.000Z";
      const futureAt = "2036-08-27T02:10:00.000Z";
      await NodeFSP.writeFile(
        path,
        `${rateLimitLine(olderAt, 40)}\n${rateLimitLine(newerAt, 57)}\n${rateLimitLine(futureAt, 99)}\n`,
      );
      const stats = await NodeFSP.stat(path);
      const files = [{ path, size: stats.size, mtimeMs: stats.mtimeMs }];

      const snapshot = await readFreshCodexRateLimitsSnapshot(
        files,
        Date.parse("2026-08-27T02:08:00.000Z"),
        Date.parse("2026-08-27T02:10:30.000Z"),
      );
      expect(snapshot?.observedAtMs).toBe(Date.parse(newerAt));
      expect(snapshot?.response.rateLimits.secondary?.usedPercent).toBe(57);
      await expect(
        readFreshCodexRateLimitsSnapshot(
          files,
          Date.parse("2026-08-27T02:11:00.000Z"),
          Date.parse("2026-08-27T02:11:30.000Z"),
        ),
      ).resolves.toBeNull();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds cold-cache tail reads to the newest rollout candidates", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-codex-limits-"));
    try {
      const files = await Promise.all(
        Array.from({ length: 9 }, async (_, index) => {
          const path = NodePath.join(directory, `rollout-${index}.jsonl`);
          await NodeFSP.writeFile(
            path,
            index === 8 ? `${rateLimitLine("2026-08-27T02:10:00.000Z", 99)}\n` : "{}\n",
          );
          const mtimeMs = Date.parse(`2026-08-27T02:10:0${8 - index}.000Z`);
          await NodeFSP.utimes(path, mtimeMs / 1_000, mtimeMs / 1_000);
          const stats = await NodeFSP.stat(path);
          return { path, size: stats.size, mtimeMs: stats.mtimeMs };
        }),
      );

      await expect(
        readFreshCodexRateLimitsSnapshot(
          files,
          Date.parse("2026-08-27T02:08:00.000Z"),
          Date.parse("2026-08-27T02:10:30.000Z"),
        ),
      ).resolves.toBeNull();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
