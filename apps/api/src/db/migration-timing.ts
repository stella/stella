/**
 * How long each part of a migrate run took, one JSON line per part on
 * stdout: the schema phase, the online phase, and every online step the
 * online phase ran. A failed part still reports its duration before the
 * failure propagates, so a run that ends in an error is measured too.
 *
 * Relative imports only: `migrate.ts` ships as a loose file.
 */

type OnlineStepKind = "index" | "cutover" | "replacement_drop" | "repair";

export type MigrationTimingRecord =
  | {
      event: "migrate.phase_duration";
      phase: "schema";
      durationMs: number;
      outcome: "applied" | "stale_bundle_noop" | "failed";
      /** Waiting for the corpus schema lane, part of the phase; null when it failed first. */
      laneWaitMs: number | null;
      appliedCount: number | null;
    }
  | {
      event: "migrate.phase_duration";
      phase: "online";
      durationMs: number;
      outcome: "complete" | "deferred" | "failed";
    }
  | {
      event: "migrate.online_step_duration";
      kind: OnlineStepKind;
      name: string;
      durationMs: number;
      outcome: "complete" | "deferred" | "pending" | "failed";
    };

/** Distributes `Omit` over the union, so each record keeps its own shape. */
type WithoutDuration<T> = T extends unknown ? Omit<T, "durationMs"> : never;

export type MigrationTimingFields = WithoutDuration<MigrationTimingRecord>;

export type MigrationTiming = {
  clock: () => number;
  emit: (record: MigrationTimingRecord) => void;
};

export const DEFAULT_MIGRATION_TIMING: MigrationTiming = {
  clock: () => performance.now(),
  emit: (record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  },
};

/**
 * Runs `work` and emits its duration with the fields `describe` derives from
 * the result, or with `failed` (the fields as `failure` gives them) when it
 * throws.
 */
export const timed = async <TResult>({
  timing,
  work,
  describe,
  failure,
}: {
  timing: MigrationTiming;
  work: () => Promise<TResult>;
  describe: (result: TResult) => MigrationTimingFields;
  failure: MigrationTimingFields & { outcome: "failed" };
}): Promise<TResult> => {
  const startedAt = timing.clock();
  const elapsed = () => Math.max(0, Math.round(timing.clock() - startedAt));
  try {
    const result = await work();
    timing.emit({ ...describe(result), durationMs: elapsed() });
    return result;
  } catch (error: unknown) {
    timing.emit({ ...failure, durationMs: elapsed() });
    throw error;
  }
};
