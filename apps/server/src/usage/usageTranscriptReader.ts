// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  parseCodexTranscriptRateLimitsSnapshot,
  type CodexTranscriptRateLimitsSnapshot,
} from "./usageSubscriptionLimits.ts";
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageRecord,
} from "./usageTranscripts.ts";

const CODEX_RATE_LIMIT_TAIL_BYTES = 1024 * 1024;

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Reads recent Codex rollout tails for the newest account-accurate rate-limit snapshot.
 *
 * Only the final MiB of each recently modified rollout is inspected. Missing a snapshot
 * merely falls back to the native probe; a stale snapshot is never returned as current.
 */
export async function readFreshCodexRateLimitsSnapshot(
  files: readonly TranscriptFile[],
  sinceMs: number,
): Promise<CodexTranscriptRateLimitsSnapshot | null> {
  const candidates = files
    .filter((file) => file.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let newest: CodexTranscriptRateLimitsSnapshot | null = null;

  for (const file of candidates) {
    let handle: NodeFSP.FileHandle | undefined;
    try {
      handle = await NodeFSP.open(file.path, "r");
      const stats = await handle.stat();
      const length = Math.min(stats.size, CODEX_RATE_LIMIT_TAIL_BYTES);
      const offset = stats.size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      const lines = buffer.toString("utf8").split(/\r?\n/);
      if (offset > 0) lines.shift();

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line === undefined || !line.includes('"rate_limits"')) continue;
        const snapshot = parseCodexTranscriptRateLimitsSnapshot(line);
        if (snapshot === null || snapshot.observedAtMs < sinceMs) continue;
        if (newest === null || snapshot.observedAtMs > newest.observedAtMs) newest = snapshot;
        break;
      }
    } catch {
      // Rollouts can rotate while the Usage page scans. The probe remains the fallback.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return newest;
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}
