import { panic, Result } from "better-result";

import {
  PROVISION_EXTRACTION_ADMISSION,
  PROVISION_EXTRACTION_ADMISSION_REVISION,
} from "@stll/legal-atlas/provision-extraction-admission";
import { Temporal } from "@stll/time";

import { isRecord } from "@/api/lib/type-guards";

import { PROVISION_CITATION_CHECK_STEP } from "./citation-checks";
import { inBackfillTransaction, PROVISION_BACKFILL_BUDGET } from "./step";
import type {
  ProvisionBackfillCompletion,
  ProvisionBackfillUnit,
  ProvisionBackfillUnitError,
  ProvisionBackfillSession,
  ProvisionBackfillStep,
} from "./step";

export const ID_PAGE_SIZE = 50;
export const BOOTSTRAP_PAGE_SIZE = 1000;
/**
 * Units one run may commit. Keyset pages are cheap one by one, so without a
 * count a run would keep reading the decision table until its wall-clock
 * deadline. With this bound a run reads at most this many pages (up to
 * `BOOTSTRAP_PAGE_SIZE` decisions each) and the next scheduled run resumes.
 */
const PROVISION_BACKFILL_UNITS_PER_RUN = 200;
const LOCK_TIMEOUT_MS = 30_000;
const STATEMENT_TIMEOUT_MS = 60_000;

type ScopeKey = { country: string; language: string };

const keyOf = ({ country, language }: ScopeKey): string =>
  `${country}\u0000${language}`;

const compareScopeKeys = (a: ScopeKey, b: ScopeKey): number => {
  const left = keyOf(a);
  const right = keyOf(b);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

/** The scopes this build admits, and the admission revision they belong to. */
type Admission = { revision: number; scopes: readonly ScopeKey[] };

const CURRENT_ADMISSION: Admission = {
  revision: PROVISION_EXTRACTION_ADMISSION_REVISION,
  scopes: Object.values(PROVISION_EXTRACTION_ADMISSION)
    .map(({ jurisdiction, language }) => ({ country: jurisdiction, language }))
    .toSorted(compareScopeKeys),
};

const readString = (row: unknown, key: string): string => {
  const value = isRecord(row) ? row[key] : undefined;
  return typeof value === "string"
    ? value
    : panic(`Provision repair returned an invalid ${key}`);
};

const readBoolean = (row: unknown, key: string): boolean => {
  const value = isRecord(row) ? row[key] : undefined;
  return typeof value === "boolean"
    ? value
    : panic(`Provision repair returned an invalid ${key}`);
};

const PAGE_BUDGET = {
  lockTimeout: LOCK_TIMEOUT_MS,
  statementTimeout: STATEMENT_TIMEOUT_MS,
} as const;

const inTransaction = async (
  connection: ProvisionBackfillSession,
  work: () => Promise<void>,
): Promise<ProvisionBackfillUnit> =>
  await inBackfillTransaction(connection, PAGE_BUDGET, work);

const readCursorCompletion = async (
  connection: ProvisionBackfillSession,
  name: string,
): Promise<ProvisionBackfillCompletion> => {
  const row = (
    await connection.query(
      `SELECT completed_at IS NOT NULL AS complete
       FROM case_law_provision_repair_cursors WHERE name = $1`,
      [name],
    )
  ).at(0);
  return row !== undefined && readBoolean(row, "complete")
    ? { type: "complete" }
    : { reason: `${name} cursor is incomplete`, type: "incomplete" };
};

type ProvisionRepairCursor =
  | { type: "complete" }
  | { type: "pending"; cursor: string | null };

const readCursor = async (
  connection: ProvisionBackfillSession,
  name: string,
): Promise<ProvisionRepairCursor> => {
  await connection.execute(
    `INSERT INTO case_law_provision_repair_cursors (name)
     VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name],
  );
  const row = (
    await connection.query(
      `SELECT cursor_decision_id::text AS cursor,
         completed_at IS NOT NULL AS complete
       FROM case_law_provision_repair_cursors WHERE name = $1 FOR UPDATE`,
      [name],
    )
  ).at(0);
  if (typeof row !== "object" || row === null || !("cursor" in row)) {
    return panic(`Provision repair ${name} cursor is missing`);
  }
  if (readBoolean(row, "complete")) {
    return { type: "complete" };
  }
  if (row.cursor !== null && typeof row.cursor !== "string") {
    return panic(`Provision repair ${name} cursor has an invalid shape`);
  }
  return { type: "pending", cursor: row.cursor };
};

const advanceCursor = async (
  connection: ProvisionBackfillSession,
  name: string,
  previous: string | null,
  next: string | null,
): Promise<void> => {
  const row = (
    await connection.query(
      `UPDATE case_law_provision_repair_cursors
       SET cursor_decision_id = coalesce($3::uuid, cursor_decision_id),
           completed_at = CASE WHEN $3::uuid IS NULL THEN now() ELSE NULL END
       WHERE name = $1 AND cursor_decision_id IS NOT DISTINCT FROM $2::uuid
         AND completed_at IS NULL
       RETURNING name`,
      [name, previous, next],
    )
  ).at(0);
  if (row === undefined) {
    panic(`Provision repair ${name} cursor changed during a page`);
  }
};

/**
 * One page of decision ids in id order. The first page and the pages after a
 * cursor are separate statements: an optional bound (`$1 IS NULL OR id > $1`)
 * is no index condition under a generic plan, so every page would walk the
 * primary key from its start. The order names the table's column: a bare
 * `id` would mean the text output column and sort every row past the cursor.
 * The size is a module constant and is written into the statement, so the
 * planner costs the page it will actually read.
 */
export const decisionPageSql = (
  cursor: "first" | "after",
  size: number,
): string => {
  if (!Number.isSafeInteger(size) || size < 1) {
    return panic("Provision repair page size must be a positive integer");
  }
  return cursor === "first"
    ? `SELECT id::text AS id FROM case_law_decisions
       ORDER BY case_law_decisions.id LIMIT ${size}`
    : `SELECT id::text AS id FROM case_law_decisions
       WHERE id > $1::uuid
       ORDER BY case_law_decisions.id LIMIT ${size}`;
};

const readDecisionPage = async (
  connection: ProvisionBackfillSession,
  cursor: string | null,
  size: number,
): Promise<string[]> => {
  const rows =
    cursor === null
      ? await connection.query(decisionPageSql("first", size))
      : await connection.query(decisionPageSql("after", size), [cursor]);
  return rows.map((row) => readString(row, "id"));
};

const repairCursorPage = async (
  connection: ProvisionBackfillSession,
  name: "scope-bootstrap" | "state-seed",
): Promise<ProvisionBackfillUnit> =>
  await inTransaction(connection, async () => {
    const cursor = await readCursor(connection, name);
    // Completion may have changed after the runner read it, while this unit
    // waited for its transaction lock. The locked row decides whether to advance.
    if (cursor.type === "complete") {
      return;
    }
    const previous = cursor.cursor;
    const ids = await readDecisionPage(
      connection,
      previous,
      name === "scope-bootstrap" ? BOOTSTRAP_PAGE_SIZE : ID_PAGE_SIZE,
    );
    if (ids.length > 0) {
      if (name === "scope-bootstrap") {
        await connection.execute(
          `INSERT INTO case_law_provision_extraction_scopes
             (country, language, status, generation)
           SELECT DISTINCT country, language, 'retired', 1
           FROM case_law_decisions WHERE id = ANY(string_to_array($1, ',')::uuid[])
           ON CONFLICT (country, language) DO NOTHING`,
          [ids.join(",")],
        );
      } else {
        await connection.query(
          `SELECT id FROM case_law_decisions WHERE id = ANY(string_to_array($1, ',')::uuid[])
           ORDER BY id FOR NO KEY UPDATE`,
          [ids.join(",")],
        );
        await connection.query(
          `SELECT scope.country, scope.language
           FROM case_law_provision_extraction_scopes scope
           WHERE (scope.country, scope.language) IN
             (SELECT country, language FROM case_law_decisions
              WHERE id = ANY(string_to_array($1, ',')::uuid[]))
           ORDER BY scope.country, scope.language FOR SHARE`,
          [ids.join(",")],
        );
        await connection.query(
          `SELECT ensure_case_law_provision_extraction_state(string_to_array($1, ',')::uuid[], 'seed')`,
          [ids.join(",")],
        );
      }
    }
    await advanceCursor(connection, name, previous, ids.at(-1) ?? null);
  });

const cursorStep = (
  name: "scope-bootstrap" | "state-seed",
): ProvisionBackfillStep => ({
  name,
  budget: PROVISION_BACKFILL_BUDGET.PAGE,
  readCompletion: async (connection) =>
    await readCursorCompletion(connection, name),
  advance: async (connection) => await repairCursorPage(connection, name),
});

const transitionScope = async (
  connection: ProvisionBackfillSession,
  { country, language }: ScopeKey,
  action: "activate" | "retire",
): Promise<void> => {
  const status = action === "activate" ? "active" : "retired";
  const row = (
    await connection.query(
      `INSERT INTO case_law_provision_extraction_scopes AS scope
           (country, language, status, generation)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (country, language) DO UPDATE
           SET status = EXCLUDED.status, generation = scope.generation + 1
           WHERE scope.status IS DISTINCT FROM EXCLUDED.status
         RETURNING generation::text AS generation`,
      [country, language, status],
    )
  ).at(0);
  if (row === undefined) {
    return;
  }
  await connection.execute(
    `INSERT INTO case_law_provision_scope_transitions
       (country, language, generation, action)
     VALUES ($1, $2, $3::bigint, $4)`,
    [country, language, readString(row, "generation"), action],
  );
};

/** The admission revision the scopes were last reconciled to, if any. */
const readAppliedAdmission = async (
  connection: ProvisionBackfillSession,
  lock: "none" | "forUpdate",
): Promise<number | null> => {
  const row = (
    await connection.query(
      `SELECT revision FROM case_law_provision_admission WHERE key = 'global'${
        lock === "forUpdate" ? " FOR UPDATE" : ""
      }`,
    )
  ).at(0);
  if (row === undefined) {
    return null;
  }
  const revision = isRecord(row) ? row["revision"] : undefined;
  return typeof revision === "number"
    ? revision
    : panic("Provision admission revision has an invalid shape");
};

const readActiveScopes = async (
  connection: ProvisionBackfillSession,
): Promise<ScopeKey[]> => {
  const rows = await connection.query(
    `SELECT country, language FROM case_law_provision_extraction_scopes
     WHERE status = 'active' ORDER BY country, language`,
  );
  return rows.map((row) => ({
    country: readString(row, "country"),
    language: readString(row, "language"),
  }));
};

/**
 * Reconciles the scopes to one build's admission. The admission row is
 * locked first (before any scope row) in every unit: a build first records
 * its revision, then applies one transition per unit, and a build whose
 * revision is below the recorded one changes nothing, so an older replica
 * cannot retire a scope a newer release admitted.
 */
const scopeSeedStep = (admission: Admission): ProvisionBackfillStep => ({
  name: "scope-seed",
  budget: PROVISION_BACKFILL_BUDGET.PAGE,
  readCompletion: async (connection) => {
    if (
      (await readAppliedAdmission(connection, "none")) !== admission.revision
    ) {
      return {
        reason: "provision scopes are not reconciled to this admission",
        type: "incomplete",
      };
    }
    const actual = new Set((await readActiveScopes(connection)).map(keyOf));
    const expected = new Set(admission.scopes.map(keyOf));
    return actual.size === expected.size &&
      [...actual].every((key) => expected.has(key))
      ? { type: "complete" }
      : {
          reason: "active provision scopes differ from the admission",
          type: "incomplete",
        };
  },
  advance: async (connection) =>
    await inTransaction(connection, async () => {
      const applied = await readAppliedAdmission(connection, "forUpdate");
      if (applied !== null && applied > admission.revision) {
        return;
      }
      if (applied === null || applied < admission.revision) {
        await connection.execute(
          `INSERT INTO case_law_provision_admission AS admission (key, revision)
           VALUES ('global', $1)
           ON CONFLICT (key) DO UPDATE
             SET revision = greatest(admission.revision, EXCLUDED.revision)`,
          [admission.revision],
        );
        return;
      }
      // Retirements first, then activations.
      const active = await readActiveScopes(connection);
      const activeKeys = new Set(active.map(keyOf));
      const desired = new Set(admission.scopes.map(keyOf));
      const retiring = active.find((scope) => !desired.has(keyOf(scope)));
      if (retiring !== undefined) {
        await transitionScope(connection, retiring, "retire");
        return;
      }
      const activating = admission.scopes.find(
        (scope) => !activeKeys.has(keyOf(scope)),
      );
      if (activating !== undefined) {
        await transitionScope(connection, activating, "activate");
      }
    }),
});

const scopeTransitionsStep: ProvisionBackfillStep = {
  name: "scope-transitions",
  budget: PROVISION_BACKFILL_BUDGET.PAGE,
  readCompletion: async (connection) => {
    const rows = await connection.query(
      `SELECT 1 FROM case_law_provision_scope_transitions
       WHERE completed_at IS NULL LIMIT 1`,
    );
    return rows.length === 0
      ? { type: "complete" }
      : { reason: "scope transitions remain", type: "incomplete" };
  },
  advance: async (connection) => {
    const row = (
      await connection.query(
        `SELECT country, language, generation::text AS generation
         FROM case_law_provision_scope_transitions
         WHERE completed_at IS NULL
         ORDER BY created_at, country, language, generation LIMIT 1`,
      )
    ).at(0);
    if (row === undefined) {
      return Result.ok(undefined);
    }
    return await inTransaction(connection, async () => {
      await connection.query(
        `SELECT run_case_law_provision_scope_transition_page($1::varchar, $2::varchar, $3::bigint)`,
        [
          readString(row, "country"),
          readString(row, "language"),
          readString(row, "generation"),
        ],
      );
    });
  },
};

/**
 * Dependency order: every decision's key has a scope row before the
 * profiles' scopes are activated, activation jobs drain before the full
 * seeding walk, and the provision-row CHECKs validate last.
 */
const backfillSteps = (
  admission: Admission,
): readonly ProvisionBackfillStep[] => [
  cursorStep("scope-bootstrap"),
  scopeSeedStep(admission),
  scopeTransitionsStep,
  cursorStep("state-seed"),
  PROVISION_CITATION_CHECK_STEP,
];

export const PROVISION_STATE_BACKFILL_STEPS = backfillSteps(CURRENT_ADMISSION);

type ProvisionStateBackfillOptions = {
  connection: ProvisionBackfillSession;
  /** Epoch milliseconds after which no further unit starts. */
  deadline: number;
  /** Checked before every unit; an aborted run starts nothing more. */
  signal: AbortSignal;
  /** Units after which no further unit starts. */
  maxUnits?: number;
  now?: () => number;
  /** The build's admission; a test stands in an older or newer build. */
  admission?: Admission;
};

type ProvisionStateBackfillOutcome =
  | { type: "complete" }
  | { type: "progress"; step: string }
  | { type: "aborted"; step: string }
  | { type: "superseded"; appliedRevision: number };

type BackfillRun = {
  connection: ProvisionBackfillSession;
  deadline: number;
  signal: AbortSignal;
  maxUnits: number;
  now: () => number;
  admission: Admission;
  steps: readonly ProvisionBackfillStep[];
};

/**
 * The run from step `index` on. Sequential by construction: a unit starts
 * only after the previous one committed, and the next completion read sees
 * its cursor.
 */
const runFrom = async (
  run: BackfillRun,
  index: number,
  units: number,
): Promise<
  Result<ProvisionStateBackfillOutcome, ProvisionBackfillUnitError>
> => {
  const step = run.steps.at(index);
  if (step === undefined) {
    return Result.ok({ type: "complete" });
  }
  if ((await step.readCompletion(run.connection)).type === "complete") {
    return await runFrom(run, index + 1, units);
  }
  if (run.signal.aborted) {
    return Result.ok({ type: "aborted", step: step.name });
  }
  // A newer release may apply its admission while this run is under way;
  // from then on this build changes nothing more.
  const applied = await readAppliedAdmission(run.connection, "none");
  if (applied !== null && applied > run.admission.revision) {
    return Result.ok({ type: "superseded", appliedRevision: applied });
  }
  const isScan = step.budget === PROVISION_BACKFILL_BUDGET.WHOLE_RUN;
  if (
    run.now() >= run.deadline ||
    units >= run.maxUnits ||
    (isScan && units > 0)
  ) {
    return Result.ok({ type: "progress", step: step.name });
  }
  const unit = await step.advance(run.connection);
  if (unit.isErr()) {
    return unit;
  }
  return isScan
    ? Result.ok({ type: "progress", step: step.name })
    : await runFrom(run, index, units + 1);
};

/**
 * One bounded run of the backfill: it stops at its deadline or after
 * `maxUnits` units. Each unit commits its own work and its cursor together,
 * so a run that stops anywhere is resumed by the next one.
 * A whole-scan unit runs alone: it starts only on a run that has done
 * nothing else, and ends the run.
 */
export const runProvisionStateBackfill = async ({
  connection,
  deadline,
  signal,
  maxUnits = PROVISION_BACKFILL_UNITS_PER_RUN,
  now = () => Temporal.Now.instant().epochMilliseconds,
  admission = CURRENT_ADMISSION,
}: ProvisionStateBackfillOptions): Promise<
  Result<ProvisionStateBackfillOutcome, ProvisionBackfillUnitError>
> =>
  await runFrom(
    {
      connection,
      deadline,
      signal,
      maxUnits,
      now,
      admission,
      steps: backfillSteps(admission),
    },
    0,
    0,
  );
