import { panic, Result } from "better-result";

import { sleep } from "@stll/concurrency/sleep";

import type { RequiredMigrationIndex } from "../lib/db/migration-history";
import { isRecord } from "../lib/type-guards";
import { BackfillHeldError } from "./backfill-runtime";
import { DEFAULT_MIGRATION_TIMING, timed } from "./migration-timing";
import type { MigrationTiming } from "./migration-timing";
import {
  createIndexConcurrently,
  createOnlineTableGate,
  declaresOnlineBuild,
  dropIndexConcurrently,
  reindexIndexConcurrently,
  renameIndex,
  runGatedTableWork,
} from "./online-ddl";
import type {
  GatedTableSession,
  OnlineConstraintValidation,
  OnlineIndexDeclaration,
} from "./online-ddl";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
  OnlineMigrationPool,
  OnlineRepair,
  OnlineRepairCompletion,
  OnlineStepIntroduction,
} from "./online-migration-connection";
import type {
  OnlineIndex,
  OnlineIndexCutover,
  OnlineIndexReplacement,
} from "./online-migration-entry";
import { ONLINE_MIGRATION_ENTRIES } from "./online-migration-registry";

// Catalog work keeps a short lock budget; every statement that locks a table
// runs through the gate in `online-ddl.ts`, which lifts it and watches the
// wait instead.
const ONLINE_MIGRATION_LOCK_TIMEOUT_SQL = "SET lock_timeout = '1s'";
// Only ever tried, never awaited in the database: a statement waiting on this
// lock runs into the statement timeout long before an index build releases it.
const ONLINE_MIGRATIONS_LOCK_SQL =
  "SELECT pg_try_advisory_lock(hashtext('stella-online-migrations')) AS acquired";
const ONLINE_MIGRATIONS_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))";
const ONLINE_MIGRATIONS_LOCK_RETRY_MS = 1000;
// Startup reads the catalog and checkpoint rows only, so a slower statement is
// waiting on a lock or a load spike; boot fails fast instead of queueing.
const STARTUP_VALIDATION_TIMEOUT_SQL = "SET statement_timeout = '5s'";
// The session is pooled: it goes back with the timeout it came with, which
// need not be the role default a RESET would give it.
const READ_STATEMENT_TIMEOUT_SQL =
  "SELECT current_setting('statement_timeout') AS timeout";
const RESTORE_STATEMENT_TIMEOUT_SQL =
  "SELECT set_config('statement_timeout', $1, false)";

const readStatementTimeout = async (
  connection: OnlineMigrationConnection,
): Promise<string> => {
  const row = (await connection.query(READ_STATEMENT_TIMEOUT_SQL)).at(0);
  if (!isRecord(row) || typeof row["timeout"] !== "string") {
    return panic("Session statement timeout is unreadable");
  }
  return row["timeout"];
};

const tryAcquireOnlineMigrationLock = async (
  connection: OnlineMigrationConnection,
): Promise<boolean> => {
  const row = (await connection.query(ONLINE_MIGRATIONS_LOCK_SQL)).at(0);
  if (!isRecord(row) || typeof row["acquired"] !== "boolean") {
    return panic("Online migration try-lock returned no verdict");
  }
  return row["acquired"];
};

/** Waits for another migrate run to finish, one try per second. */
export const acquireOnlineMigrationLock = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  if (await tryAcquireOnlineMigrationLock(connection)) {
    return;
  }
  await sleep(ONLINE_MIGRATIONS_LOCK_RETRY_MS);
  await acquireOnlineMigrationLock(connection);
};

export const releaseOnlineMigrationLock = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  await connection.execute(ONLINE_MIGRATIONS_UNLOCK_SQL);
};
const READ_INDEX_STATE_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND index_relation.relname = $2
    AND table_relation.relname = $3
`;
const READ_REINDEX_ARTIFACTS_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND table_relation.relname = $2
    AND (
      starts_with(index_relation.relname, $3)
      OR starts_with(index_relation.relname, $4)
    )
`;

export const ONLINE_MIGRATION_INDEXES: readonly OnlineIndex[] =
  ONLINE_MIGRATION_ENTRIES.flatMap((entry) =>
    entry.type === "indexes" ? entry.values : [],
  );

export const ONLINE_MIGRATION_INDEX_CUTOVERS: readonly OnlineIndexCutover[] =
  ONLINE_MIGRATION_ENTRIES.flatMap((entry) =>
    entry.type === "cutovers" ? entry.values : [],
  );

export const ONLINE_INDEX_REPLACEMENTS: readonly OnlineIndexReplacement[] =
  ONLINE_MIGRATION_ENTRIES.flatMap((entry) =>
    entry.type === "replacements" ? entry.values : [],
  );

/**
 * Index names a concurrent `IF NOT EXISTS` build may rely on, because this
 * phase reconciles them on every boot.
 *
 * Retired legacy names count: a replacement is proven ready before the legacy
 * index is dropped, and the drop reconciles an `INVALID` leftover from an
 * interrupted historical build as surely as a rebuild would. A name with
 * neither a registry entry, a cutover, nor a retirement still has no
 * postcondition and is still rejected.
 */
export const ONLINE_VALIDATED_INDEX_NAMES: ReadonlySet<string> = new Set([
  ...ONLINE_MIGRATION_INDEXES.map(({ name }) => name),
  ...ONLINE_MIGRATION_INDEX_CUTOVERS.flatMap(({ final, staged }) => [
    final.name,
    staged.name,
  ]),
  ...ONLINE_INDEX_REPLACEMENTS.map(({ legacyName }) => legacyName),
]);

/**
 * Data repairs a schema migration left to this phase, run after the index
 * steps so an index a repair walks is one that already exists. Each is
 * self-checkpointing (see `OnlineRepair`); the phase only sequences them,
 * skips the ones already complete, and validates their completion.
 */
export const ONLINE_MIGRATION_REPAIRS: readonly OnlineRepair[] =
  ONLINE_MIGRATION_ENTRIES.flatMap((entry) =>
    entry.type === "repairs" ? entry.values : [],
  );

/**
 * Every constraint a registered repair validates through the table gate. The
 * entity feature gate's checks are validated on each relation of a graph the
 * database holds, so `ENTITY_FEATURE_GATE_CONSTRAINT_NAMES` names those.
 */
export const ONLINE_CONSTRAINT_VALIDATIONS: readonly OnlineConstraintValidation[] =
  ONLINE_MIGRATION_ENTRIES.flatMap((entry) =>
    entry.type === "constraints" ? entry.values : [],
  );

type PresentIndexState = {
  definition: string;
  isReady: boolean;
  isUnique: boolean;
  isValid: boolean;
  name: string;
  type: "present";
};

type OnlineIndexState = { type: "missing" } | PresentIndexState;

/** Only repair builds indexes, so only repair carries the index gate. */
type OnlineMigrationMode =
  | {
      operation: "repair";
      indexGate: OnlineIndexGateOptions;
      reserveObserver: () => Promise<OnlineMigrationConnection>;
      timing: MigrationTiming;
    }
  | { operation: "validate"; report: OnlineMigrationStartupReport };

type OnlineMigrationOptions = {
  repairs?: readonly OnlineRepair[];
  log?: (record: {
    event: "online_repair_pending";
    repair: string;
    completion: Extract<OnlineRepairCompletion, { type: "pending" }>;
  }) => void;
};

const COMPLETE = { type: "complete" } as const satisfies OnlineMigrationOutcome;

export type OnlineRepairOptions = OnlineMigrationOptions & {
  indexGate: OnlineIndexGateOptions;
  /** Opens a separate session in the database `pool` reserves from. */
  reserveObserver: () => Promise<OnlineMigrationConnection>;
  /** Where each step's duration goes; JSON lines on stdout otherwise. */
  timing?: MigrationTiming;
};

export const runOnlineMigrations = async (
  pool: OnlineMigrationPool,
  {
    indexGate,
    reserveObserver,
    timing = DEFAULT_MIGRATION_TIMING,
    ...options
  }: OnlineRepairOptions,
): Promise<OnlineMigrationOutcome> =>
  await processOnlineMigrations(
    pool,
    { operation: "repair", indexGate, reserveObserver, timing },
    options,
  );

type PendingOnlineMigrationStep = {
  kind: "index" | "cutover" | "replacement_drop" | "repair";
  name: string;
  introducedBy: OnlineStepIntroduction;
};

export type OnlineMigrationStartupReport = {
  newestAppliedMigration: string;
  pending: PendingOnlineMigrationStep[];
};

/**
 * Startup validation. It never waits on the migrator: a migrate run holds the
 * online lock for a whole index build, longer than any statement timeout, so
 * a waiting boot would fail on the timeout instead. While the migrator holds
 * the lock it owns these objects and may be mid-cutover, so startup leaves
 * them to it rather than read a state between two of its statements.
 */
export const reportOnlineMigrations = async (
  pool: OnlineMigrationPool,
  options: OnlineMigrationOptions = {},
): Promise<
  | { type: "validated"; report: OnlineMigrationStartupReport }
  | { type: "migrator_active" }
> => {
  const connection = await pool.reserve();
  try {
    const sessionTimeout = await readStatementTimeout(connection);
    await connection.execute(STARTUP_VALIDATION_TIMEOUT_SQL);
    try {
      if (!(await tryAcquireOnlineMigrationLock(connection))) {
        return { type: "migrator_active" };
      }
      try {
        const row = (
          await connection.query(
            "SELECT name FROM drizzle.__drizzle_migrations WHERE name IS NOT NULL ORDER BY name DESC LIMIT 1",
          )
        ).at(0);
        if (!isRecord(row) || typeof row["name"] !== "string") {
          panic("Online migration startup requires a named applied migration");
        }
        const report: OnlineMigrationStartupReport = {
          newestAppliedMigration: row["name"],
          pending: [],
        };
        const outcome = await walkOnlineMigrations({
          connection,
          mode: { operation: "validate", report },
          options,
        });
        if (outcome.type !== "complete") {
          panic("Online migration validation cannot defer");
        }
        return { type: "validated", report };
      } finally {
        await releaseOnlineMigrationLock(connection);
      }
    } finally {
      await connection.query(RESTORE_STATEMENT_TIMEOUT_SQL, [sessionTimeout]);
    }
  } finally {
    await connection.release();
  }
};

type ReportPendingStepOptions = {
  report: OnlineMigrationStartupReport;
  step: PendingOnlineMigrationStep;
  reason: string;
};

const reportPendingStep = ({
  report,
  step,
  reason,
}: ReportPendingStepOptions): void => {
  if (typeof step.introducedBy !== "string") {
    panic(
      `Online ${step.kind} ${step.name} owned by ${step.introducedBy.owner} is not complete: ${reason}`,
    );
  }
  if (step.introducedBy !== report.newestAppliedMigration) {
    panic(
      `Online ${step.kind} ${step.name} introduced by ${step.introducedBy} is not complete: ${reason}`,
    );
  }
  if (
    !report.pending.some(
      ({ kind, name }) => kind === step.kind && name === step.name,
    )
  ) {
    report.pending.push(step);
  }
};

const processOnlineMigrations = async (
  pool: OnlineMigrationPool,
  mode: Extract<OnlineMigrationMode, { operation: "repair" }>,
  options: OnlineMigrationOptions,
): Promise<OnlineMigrationOutcome> => {
  const connection = await pool.reserve();
  let sessionStatus: "active" | "terminated" = "active";
  const sessionIsActive = () => sessionStatus === "active";
  const terminate = connection.terminate;
  if (terminate) {
    connection.terminate = async () => {
      sessionStatus = "terminated";
      await terminate();
    };
  }
  let lockAcquired = false;

  try {
    await acquireOnlineMigrationLock(connection);
    lockAcquired = true;
    await connection.execute(ONLINE_MIGRATION_LOCK_TIMEOUT_SQL);
    await connection.execute("SET statement_timeout = '0'");
    return await walkOnlineMigrations({ connection, mode, options });
  } finally {
    try {
      if (lockAcquired && sessionIsActive()) {
        await releaseOnlineMigrationLock(connection);
      }
    } finally {
      await connection.release();
    }
  }
};

type WalkOnlineMigrationsOptions = {
  connection: OnlineMigrationConnection;
  mode: OnlineMigrationMode;
  options: OnlineMigrationOptions;
};

/** Every online step in order, on a session that holds the online lock. */
const walkOnlineMigrations = async ({
  connection,
  mode,
  options,
}: WalkOnlineMigrationsOptions): Promise<OnlineMigrationOutcome> => {
  const indexes = await processOnlineIndexAt({ connection, mode });
  if (indexes.type === "deferred") {
    return indexes;
  }
  const cutovers = await processOnlineIndexCutoverAt({ connection, mode });
  if (cutovers.type === "deferred") {
    return cutovers;
  }
  if (mode.operation === "repair") {
    const retirements = await retireReplacedIndexAt(connection, mode);
    if (retirements.type === "deferred") {
      return retirements;
    }
  } else {
    await reportOnlineReplacements({ connection, report: mode.report });
  }
  return await processOnlineRepairAt({
    connection,
    mode,
    repairs: options.repairs ?? ONLINE_MIGRATION_REPAIRS,
    log:
      options.log ??
      ((record) => process.stderr.write(`${JSON.stringify(record)}\n`)),
  });
};

type OnlineIndexWalkOptions = {
  connection: OnlineMigrationConnection;
  mode: OnlineMigrationMode;
  offset?: number;
};

const processOnlineIndexAt = async ({
  connection,
  mode,
  offset = 0,
}: OnlineIndexWalkOptions): Promise<OnlineMigrationOutcome> => {
  const index = ONLINE_MIGRATION_INDEXES.at(offset);
  if (!index) {
    return COMPLETE;
  }

  if (mode.operation === "repair") {
    const step = {
      event: "migrate.online_step_duration",
      kind: "index",
      name: index.name,
    } as const;
    const outcome = await timed({
      timing: mode.timing,
      work: async () =>
        await ensureOnlineIndexValid({
          connection,
          index,
          gate: mode.indexGate,
          reserveObserver: mode.reserveObserver,
        }),
      describe: ({ type }) => ({ ...step, outcome: type }),
      failure: { ...step, outcome: "failed" },
    });
    if (outcome.type === "deferred") {
      return outcome;
    }
  } else {
    await reportIndexReadiness({
      connection,
      index,
      report: mode.report,
      kind: "index",
    });
  }
  return await processOnlineIndexAt({
    connection,
    mode,
    offset: offset + 1,
  });
};

const processOnlineIndexCutoverAt = async ({
  connection,
  mode,
  offset = 0,
}: OnlineIndexWalkOptions): Promise<OnlineMigrationOutcome> => {
  const cutover = ONLINE_MIGRATION_INDEX_CUTOVERS.at(offset);
  if (!cutover) {
    return COMPLETE;
  }

  if (mode.operation === "repair") {
    const step = {
      event: "migrate.online_step_duration",
      kind: "cutover",
      name: cutover.final.name,
    } as const;
    const outcome = await timed({
      timing: mode.timing,
      work: async () =>
        await completeIndexCutover({
          connection,
          cutover,
          gate: mode.indexGate,
          reserveObserver: mode.reserveObserver,
        }),
      describe: ({ type }) => ({ ...step, outcome: type }),
      failure: { ...step, outcome: "failed" },
    });
    if (outcome.type === "deferred") {
      return outcome;
    }
  } else {
    await reportIndexCutoverReadiness({
      connection,
      cutover,
      report: mode.report,
    });
    const stagedState = await readIndexState(connection, cutover.staged);
    const stagedArtifacts = await readReindexArtifacts(
      connection,
      cutover.staged,
    );
    for (const artifact of stagedArtifacts) {
      assertIndexDefinition(cutover.staged, artifact);
      if (artifact.isValid) {
        panic(
          `Required migration index ${cutover.staged.name} introduced by ${cutover.introducedBy} has a valid reindex artifact`,
        );
      }
    }
    if (stagedArtifacts.length > 0) {
      reportPendingStep({
        report: mode.report,
        step: {
          kind: "cutover",
          name: cutover.final.name,
          introducedBy: cutover.introducedBy,
        },
        reason: "staged reindex artifacts remain",
      });
    }
    if (stagedState.type === "present") {
      assertIndexDefinition(cutover.staged, stagedState);
      reportPendingStep({
        report: mode.report,
        step: {
          kind: "cutover",
          name: cutover.final.name,
          introducedBy: cutover.introducedBy,
        },
        reason: "staged index remains",
      });
    }
  }
  return await processOnlineIndexCutoverAt({
    connection,
    mode,
    offset: offset + 1,
  });
};

type OnlineRepairWalkOptions = {
  connection: OnlineMigrationConnection;
  mode: OnlineMigrationMode;
  repairs: readonly OnlineRepair[];
  log: NonNullable<OnlineMigrationOptions["log"]>;
  offset?: number;
};

const processOnlineRepairAt = async ({
  connection,
  mode,
  repairs,
  log,
  offset = 0,
}: OnlineRepairWalkOptions): Promise<OnlineMigrationOutcome> => {
  const repair = repairs.at(offset);
  if (!repair) {
    return COMPLETE;
  }

  const completion = await repair.readCompletion(connection);
  if (mode.operation === "validate") {
    if (completion.type !== "complete") {
      reportPendingStep({
        report: mode.report,
        step: {
          kind: "repair",
          name: repair.name,
          introducedBy: repair.introducedBy,
        },
        reason: completion.reason,
      });
    }
    return await processOnlineRepairAt({
      connection,
      mode,
      repairs,
      log,
      offset: offset + 1,
    });
  }
  if (completion.type !== "complete") {
    const step = {
      event: "migrate.online_step_duration",
      kind: "repair",
      name: repair.name,
    } as const;
    // The postconditions run inside the timed work, so a repair they reject
    // is reported as failed, never as pending.
    const settled = await timed({
      timing: mode.timing,
      work: async (): Promise<
        | OnlineRepairCompletion
        | Extract<OnlineMigrationOutcome, { type: "deferred" }>
      > => {
        const attempt = await Result.tryPromise({
          try: async () =>
            await repair.repair(
              connection,
              createOnlineTableGate({
                connection,
                gate: mode.indexGate,
                reserveObserver: mode.reserveObserver,
              }),
            ),
          catch: (cause: unknown) => cause,
        });
        await connection.execute(ONLINE_MIGRATION_LOCK_TIMEOUT_SQL);
        if (
          Result.isError(attempt) &&
          !(attempt.error instanceof BackfillHeldError)
        ) {
          throw attempt.error;
        }
        // A deferred validation leaves its constraint NOT VALID, so the next
        // run reads the repair incomplete and calls it again.
        if (Result.isOk(attempt) && attempt.value.type === "deferred") {
          return attempt.value;
        }
        const after = await repair.readCompletion(connection);
        if (Result.isError(attempt) && after.type !== "pending") {
          return panic(
            `Online repair ${repair.name}: hold has no durable pending checkpoint`,
          );
        }
        assertRepairDeployable(repair, after);
        return after;
      },
      describe: ({ type }) => ({
        ...step,
        outcome: type === "complete" || type === "deferred" ? type : "pending",
      }),
      failure: { ...step, outcome: "failed" },
    });
    if (settled.type === "deferred") {
      return settled;
    }
    if (settled.type === "pending") {
      log({
        event: "online_repair_pending",
        repair: repair.name,
        completion: settled,
      });
    }
  } else {
    assertRepairDeployable(repair, completion);
  }
  return await processOnlineRepairAt({
    connection,
    mode,
    repairs,
    log,
    offset: offset + 1,
  });
};

const assertRepairDeployable = (
  { name }: OnlineRepair,
  completion: OnlineRepairCompletion,
): void => {
  switch (completion.type) {
    case "complete":
    case "pending":
      return;
    case "incomplete":
      return panic(
        `Online repair ${name} is not complete: ${completion.reason}`,
        completion.cause,
      );
    default:
      completion satisfies never;
      return panic(`Online repair ${name}: unexpected completion state`);
  }
};

const retireReplacedIndexAt = async (
  connection: OnlineMigrationConnection,
  repair: Extract<OnlineMigrationMode, { operation: "repair" }>,
  offset = 0,
): Promise<OnlineMigrationOutcome> => {
  const replacement = ONLINE_INDEX_REPLACEMENTS.at(offset);
  if (!replacement) {
    return COMPLETE;
  }

  const step = {
    event: "migrate.online_step_duration",
    kind: "replacement_drop",
    name: replacement.legacyName,
  } as const;
  const outcome = await timed({
    timing: repair.timing,
    work: async () => {
      await assertReplacementIndexAt(connection, replacement);
      return await retireOnlineIndex({
        connection,
        index: {
          name: replacement.legacyName,
          tableName: replacementTableName(replacement),
        },
        gate: repair.indexGate,
        reserveObserver: repair.reserveObserver,
      });
    },
    describe: ({ type }) => ({ ...step, outcome: type }),
    failure: { ...step, outcome: "failed" },
  });
  if (outcome.type === "deferred") {
    return outcome;
  }
  return await retireReplacedIndexAt(connection, repair, offset + 1);
};

/** A replaced index lives on the table its replacements cover. */
export const replacementTableName = ({
  legacyName,
  replacementNames,
}: OnlineIndexReplacement): string => {
  const tableNames = new Set(
    replacementNames.map(
      (replacementName) =>
        ONLINE_MIGRATION_INDEXES.find(({ name }) => name === replacementName)
          ?.tableName ??
        panic(
          `Replacement index ${replacementName} is not registered for online validation`,
        ),
    ),
  );
  const [tableName, ...others] = tableNames;
  if (tableName === undefined || others.length > 0) {
    return panic(
      `Replaced index ${legacyName} needs replacements on exactly one table`,
    );
  }
  return tableName;
};

type RetireOnlineIndexOptions = {
  connection: OnlineMigrationConnection;
  index: Pick<RequiredMigrationIndex, "name" | "tableName">;
  gate: OnlineIndexGateOptions;
  reserveObserver: () => Promise<OnlineMigrationConnection>;
};

/**
 * Drops a replaced index. The drop waits for every transaction on the table,
 * so it runs through the index gate like a build: a drop the gate holds or
 * cancels defers the phase, and keeping the index meanwhile only costs
 * writes. A drop cancelled after PostgreSQL marked the index invalid leaves
 * it `INVALID`; the next run finds it present and drops it the same way.
 */
export const retireOnlineIndex = async ({
  connection,
  index,
  gate,
  reserveObserver,
}: RetireOnlineIndexOptions): Promise<OnlineMigrationOutcome> => {
  // Once retired, the step reads the catalog and nothing else, so a held gate
  // never defers a phase over an index that is already gone.
  if ((await readIndexState(connection, index)).type === "missing") {
    return COMPLETE;
  }
  return await runGatedTableWork({
    connection,
    gate,
    reserveObserver,
    target: index,
    kind: "index_repair",
    work: async (session) => {
      await session.run(dropIndexConcurrently(index, { ifExists: true }));
    },
  });
};

type ReportOnlineReplacementsOptions = {
  connection: OnlineMigrationConnection;
  report: OnlineMigrationStartupReport;
  offset?: number;
};

const reportOnlineReplacements = async ({
  connection,
  report,
  offset = 0,
}: ReportOnlineReplacementsOptions): Promise<void> => {
  const replacement = ONLINE_INDEX_REPLACEMENTS.at(offset);
  if (!replacement) {
    return;
  }
  const index = ONLINE_MIGRATION_INDEXES.find(({ name }) =>
    replacement.replacementNames.includes(name),
  );
  if (!index) {
    panic(
      `Online replacement ${replacement.legacyName} has no registered index`,
    );
  }
  const legacy = { ...index, name: replacement.legacyName };
  const state = await readIndexState(connection, legacy);
  const artifacts = await readReindexArtifacts(connection, legacy);
  if (artifacts.some(({ isValid }) => isValid)) {
    panic(
      `Required migration index ${legacy.name} ${typeof replacement.introducedBy === "string" ? `introduced by ${replacement.introducedBy}` : `owned by ${replacement.introducedBy.owner}`} has a valid reindex artifact`,
    );
  }
  if (state.type === "present" || artifacts.length > 0) {
    reportPendingStep({
      report,
      step: {
        kind: "replacement_drop",
        name: legacy.name,
        introducedBy: replacement.introducedBy,
      },
      reason: "retired index remains",
    });
  }
  await reportOnlineReplacements({ connection, report, offset: offset + 1 });
};

const assertReplacementIndexAt = async (
  connection: OnlineMigrationConnection,
  replacement: OnlineIndexReplacement,
  offset = 0,
): Promise<void> => {
  const replacementName = replacement.replacementNames.at(offset);
  if (!replacementName) {
    return;
  }
  const index = ONLINE_MIGRATION_INDEXES.find(
    ({ name }) => name === replacementName,
  );
  if (!index) {
    panic(
      `Replacement index ${replacementName} is not registered for online validation`,
    );
  }

  await assertIndexReady(connection, index);
  await assertReplacementIndexAt(connection, replacement, offset + 1);
};

const parsePresentIndexState = (row: unknown): PresentIndexState => {
  if (
    typeof row !== "object" ||
    row === null ||
    !("definition" in row) ||
    typeof row.definition !== "string" ||
    !("isReady" in row) ||
    typeof row.isReady !== "boolean" ||
    !("isUnique" in row) ||
    typeof row.isUnique !== "boolean" ||
    !("isValid" in row) ||
    typeof row.isValid !== "boolean" ||
    !("name" in row) ||
    typeof row.name !== "string"
  ) {
    panic("Online migration index state has an invalid shape");
  }

  return {
    definition: row.definition,
    isReady: row.isReady,
    isUnique: row.isUnique,
    isValid: row.isValid,
    name: row.name,
    type: "present",
  };
};

const readIndexState = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  { name, tableName }: Pick<RequiredMigrationIndex, "name" | "tableName">,
): Promise<OnlineIndexState> => {
  const row = (
    await connection.query(READ_INDEX_STATE_SQL, ["public", name, tableName])
  ).at(0);
  return row === undefined ? { type: "missing" } : parsePresentIndexState(row);
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

const reindexArtifactPrefix = (name: string, suffix: "_ccnew" | "_ccold") =>
  `${name.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length)}${suffix}`;

const readReindexArtifacts = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  { name, tableName }: RequiredMigrationIndex,
): Promise<PresentIndexState[]> =>
  (
    await connection.query(READ_REINDEX_ARTIFACTS_SQL, [
      "public",
      tableName,
      reindexArtifactPrefix(name, "_ccnew"),
      reindexArtifactPrefix(name, "_ccold"),
    ])
  ).map(parsePresentIndexState);

const definitionBody = (definition: string): string => {
  const bodyStart = definition.indexOf(" ON ");
  if (bodyStart === -1) {
    panic("Online migration index definition has an invalid shape");
  }
  return definition.slice(bodyStart + 1);
};

const assertIndexDefinition = (
  index: RequiredMigrationIndex,
  state: PresentIndexState,
): void => {
  if (!hasExpectedIndexDefinition(index, state)) {
    panic(
      `Required migration index ${index.name} has an unexpected definition`,
    );
  }
};

const hasExpectedIndexDefinition = (
  index: RequiredMigrationIndex,
  state: PresentIndexState,
): boolean =>
  state.isUnique === index.isUnique &&
  definitionBody(state.definition) === index.definitionBody;

const assertNoReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(connection, index);
  if (artifacts.length > 0) {
    panic(`Required migration index ${index.name} has reindex artifacts`);
  }
};

/** Runs only inside gated index work: each artifact drop waits for the table. */
const cleanupFailedReindexArtifacts = async (
  session: GatedTableSession,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(session, index);
  await cleanupReindexArtifactAt(session, index, artifacts);
};

const cleanupReindexArtifactAt = async (
  session: GatedTableSession,
  index: RequiredMigrationIndex,
  artifacts: readonly PresentIndexState[],
  offset = 0,
): Promise<void> => {
  const artifact = artifacts.at(offset);
  if (!artifact) {
    return;
  }

  assertIndexDefinition(index, artifact);
  if (artifact.isValid) {
    panic(
      `Required migration index ${index.name} has a valid reindex artifact`,
    );
  }
  await session.run(
    dropIndexConcurrently(
      { name: artifact.name, tableName: index.tableName },
      { ifExists: false },
    ),
  );
  await cleanupReindexArtifactAt(session, index, artifacts, offset + 1);
};

type ReportIndexReadinessOptions = {
  connection: OnlineMigrationConnection;
  index: RequiredMigrationIndex & { introducedBy: OnlineStepIntroduction };
  report: OnlineMigrationStartupReport;
  kind: "index" | "cutover";
};

const reportIndexReadiness = async ({
  connection,
  index,
  report,
  kind,
}: ReportIndexReadinessOptions): Promise<void> => {
  const state = await readIndexState(connection, index);
  if (state.type === "present") {
    assertIndexDefinition(index, state);
  }
  const artifacts = await readReindexArtifacts(connection, index);
  for (const artifact of artifacts) {
    assertIndexDefinition(index, artifact);
    if (artifact.isValid) {
      panic(
        `Required migration index ${index.name} ${typeof index.introducedBy === "string" ? `introduced by ${index.introducedBy}` : `owned by ${index.introducedBy.owner}`} has a valid reindex artifact`,
      );
    }
  }
  if (
    state.type === "missing" ||
    !state.isReady ||
    !state.isValid ||
    artifacts.length > 0
  ) {
    reportPendingStep({
      report,
      step: { kind, name: index.name, introducedBy: index.introducedBy },
      reason:
        state.type === "missing"
          ? "index is missing"
          : "index is not ready or has reindex artifacts",
    });
  }
};

type ReportIndexCutoverReadinessOptions = {
  connection: OnlineMigrationConnection;
  cutover: OnlineIndexCutover;
  report: OnlineMigrationStartupReport;
};

const reportIndexCutoverReadiness = async ({
  connection,
  cutover: { final, introducedBy, legacy },
  report,
}: ReportIndexCutoverReadinessOptions): Promise<void> => {
  const state = await readIndexState(connection, final);
  const finalHasExpectedDefinition =
    state.type === "present" && hasExpectedIndexDefinition(final, state);
  const finalHasLegacyDefinition =
    state.type === "present" && hasExpectedIndexDefinition(legacy, state);
  if (
    state.type === "present" &&
    !finalHasExpectedDefinition &&
    !finalHasLegacyDefinition
  ) {
    assertIndexDefinition(final, state);
  }

  const artifacts = await readReindexArtifacts(connection, final);
  for (const artifact of artifacts) {
    assertIndexDefinition(final, artifact);
    if (artifact.isValid) {
      panic(
        `Required migration index ${final.name} introduced by ${introducedBy} has a valid reindex artifact`,
      );
    }
  }
  if (
    state.type === "missing" ||
    finalHasLegacyDefinition ||
    !state.isReady ||
    !state.isValid ||
    artifacts.length > 0
  ) {
    let reason = "index is not ready or has reindex artifacts";
    if (state.type === "missing") {
      reason = "index is missing";
    } else if (finalHasLegacyDefinition) {
      reason = "final index still has its legacy definition";
    }
    reportPendingStep({
      report,
      step: { kind: "cutover", name: final.name, introducedBy },
      reason,
    });
  }
};

const assertIndexReady = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const state = await readIndexState(connection, index);
  if (state.type === "missing") {
    panic(`Required migration index ${index.name} is missing`);
  }
  assertIndexDefinition(index, state);
  if (!state.isValid || !state.isReady) {
    panic(`Required migration index ${index.name} is not ready`);
  }
  await assertNoReindexArtifacts(connection, index);
};

type EnsureOnlineIndexOptions = {
  connection: OnlineMigrationConnection;
  index: OnlineIndexDeclaration;
  gate: OnlineIndexGateOptions;
  reserveObserver: () => Promise<OnlineMigrationConnection>;
};

export const ensureOnlineIndexValid = async ({
  connection,
  index,
  gate,
  reserveObserver,
}: EnsureOnlineIndexOptions): Promise<OnlineMigrationOutcome> => {
  const initialState = await readIndexState(connection, index);
  if (initialState.type === "present") {
    assertIndexDefinition(index, initialState);
    if (
      initialState.isValid &&
      initialState.isReady &&
      (await readReindexArtifacts(connection, index)).length === 0
    ) {
      return COMPLETE;
    }
  } else if (!declaresOnlineBuild(index)) {
    panic(`Required migration index ${index.name} is missing`);
  }
  const outcome = await runGatedTableWork({
    connection,
    gate,
    reserveObserver,
    target: index,
    kind: initialState.type === "present" ? "index_repair" : "index_build",
    work: async (session) => {
      await cleanupFailedReindexArtifacts(session, index);
      const state = await readIndexState(session, index);
      if (state.type === "present") {
        assertIndexDefinition(index, state);
        if (state.isValid && state.isReady) {
          return;
        }
        // An interrupted concurrent build can leave the index ready but
        // invalid: PostgreSQL still maintains it, and a unique one still
        // rejects duplicates. REINDEX builds the copy beside it and swaps
        // only once the copy is valid, so enforcement never lapses; a
        // DROP before CREATE would let a duplicate commit in between.
        await session.run(reindexIndexConcurrently(index));
        return;
      }
      if (!declaresOnlineBuild(index)) {
        panic(`Required migration index ${index.name} is missing`);
      }
      await session.run(createIndexConcurrently(index));
    },
  });
  if (outcome.type === "complete") {
    await assertIndexReady(connection, index);
  }
  return outcome;
};

type CompleteIndexCutoverOptions = {
  connection: OnlineMigrationConnection;
  cutover: OnlineIndexCutover;
  gate: OnlineIndexGateOptions;
  reserveObserver: () => Promise<OnlineMigrationConnection>;
};

export const completeIndexCutover = async ({
  connection,
  cutover: { final, staged },
  gate: indexGate,
  reserveObserver,
}: CompleteIndexCutoverOptions): Promise<OnlineMigrationOutcome> => {
  const finalState = await readIndexState(connection, final);

  if (finalState.type === "present") {
    const finalIsReady =
      hasExpectedIndexDefinition(final, finalState) &&
      finalState.isValid &&
      finalState.isReady;

    if (finalIsReady) {
      const stagedState = await readIndexState(connection, staged);
      if (stagedState.type === "present") {
        assertIndexDefinition(staged, stagedState);
      }
      const artifacts = await readReindexArtifacts(connection, final);
      if (stagedState.type === "present" || artifacts.length > 0) {
        const cleanup = await runGatedTableWork({
          connection,
          gate: indexGate,
          reserveObserver,
          target: final,
          kind: "index_repair",
          work: async (session) => {
            await cleanupFailedReindexArtifacts(session, final);
            if (stagedState.type === "present") {
              await session.run(
                dropIndexConcurrently(staged, { ifExists: false }),
              );
            }
          },
        });
        if (cleanup.type === "deferred") {
          return cleanup;
        }
      }
      await assertIndexReady(connection, final);
      return COMPLETE;
    }
  }

  const stagedOutcome = await ensureOnlineIndexValid({
    connection,
    index: staged,
    gate: indexGate,
    reserveObserver,
  });
  if (stagedOutcome.type === "deferred") {
    return stagedOutcome;
  }

  // The drop of a stale final index and the rename run as one gated unit, so
  // readers lose the final name only between two statements of one session.
  // A drop cancelled into INVALID leaves the final index present and not
  // ready, and a deferred rename leaves the staged index in place, so the
  // next run takes this path again either way.
  const renamed = await runGatedTableWork({
    connection,
    gate: indexGate,
    reserveObserver,
    target: final,
    kind: "index_repair",
    work: async (session) => {
      if (finalState.type === "present") {
        await session.run(dropIndexConcurrently(final, { ifExists: false }));
      }
      await session.run(renameIndex({ from: staged, to: final }));
    },
  });
  if (renamed.type === "deferred") {
    return renamed;
  }
  await assertIndexReady(connection, final);
  return COMPLETE;
};
