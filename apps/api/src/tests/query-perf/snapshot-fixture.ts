import { panic } from "better-result";
import { existsSync } from "node:fs";

import type { QueryPerfProfileId } from "./profiles";

type RunSnapshotFixtureOptions<TSeed, TResult> = {
  profileId: QueryPerfProfileId;
  archive: string | undefined;
  source: "fresh" | "snapshot";
  downloadMilliseconds: number;
  seed: () => Promise<TSeed>;
  restore: () => Promise<{ restoreMs: number; archiveBytes: number }>;
  read: () => Promise<TSeed>;
  save: () => Promise<{ saveMs: number; archiveBytes: number }>;
  run: (seed: TSeed) => Promise<TResult>;
  report: (event: Record<string, string | number>) => void;
  now?: () => number;
};

export const runSnapshotFixture = async <TSeed, TResult>({
  profileId,
  archive,
  source,
  downloadMilliseconds,
  seed,
  restore,
  read,
  save,
  run,
  report,
  now = () => performance.now(),
}: RunSnapshotFixtureOptions<TSeed, TResult>) => {
  if (!Number.isFinite(downloadMilliseconds) || downloadMilliseconds < 0) {
    return panic("Query performance cache download timing must be nonnegative");
  }
  const started = now();
  const hit = source === "snapshot";
  if (hit && (archive === undefined || !existsSync(archive))) {
    return panic("Exact query performance cache hit is missing its archive");
  }
  const fixture = hit
    ? await (async () => {
        const result = await restore();
        const restored = await read();
        const restoreMilliseconds = now() - started;
        report({
          event: "query_perf_snapshot_restore",
          profileId,
          downloadMilliseconds,
          archiveRestoreMilliseconds: result.restoreMs,
          restoreMilliseconds,
          totalRestoreMilliseconds: downloadMilliseconds + restoreMilliseconds,
          archiveBytes: result.archiveBytes,
        });
        return restored;
      })()
    : await seed();
  if (!hit) {
    report({
      event: "query_perf_seed",
      profileId,
      seedMilliseconds: now() - started,
    });
  }
  const result = await run(fixture);
  if (!hit && archive !== undefined) {
    const saved = await save();
    report({
      event: "query_perf_snapshot_save",
      profileId,
      saveMilliseconds: saved.saveMs,
      archiveBytes: saved.archiveBytes,
    });
  }
  return result;
};
