import { panic, Result } from "better-result";

import { PROVISION_CITATION_PROFILES } from "@stll/legal-atlas/provision-citation-profiles";
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

const ID_PAGE_SIZE = 50;
const BOOTSTRAP_PAGE_SIZE = 1000;
const LOCK_TIMEOUT = "30s";
const STATEMENT_TIMEOUT = "1min";

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

export const PROVISION_CITATION_SCOPE_KEYS: readonly ScopeKey[] =
  Object.entries(PROVISION_CITATION_PROFILES)
    .flatMap(([country, profile]) =>
      profile.languages.map((language) => ({ country, language })),
    )
    .toSorted(compareScopeKeys);

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
  lockTimeout: LOCK_TIMEOUT,
  statementTimeout: STATEMENT_TIMEOUT,
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

const readCursor = async (
  connection: ProvisionBackfillSession,
  name: string,
): Promise<string | null> => {
  await connection.execute(
    `INSERT INTO case_law_provision_repair_cursors (name)
     VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name],
  );
  const row = (
    await connection.query(
      `SELECT cursor_decision_id::text AS cursor
       FROM case_law_provision_repair_cursors WHERE name = $1`,
      [name],
    )
  ).at(0);
  if (typeof row !== "object" || row === null || !("cursor" in row)) {
    return panic(`Provision repair ${name} cursor is missing`);
  }
  if (row.cursor !== null && typeof row.cursor !== "string") {
    return panic(`Provision repair ${name} cursor has an invalid shape`);
  }
  return row.cursor;
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

const readDecisionPage = async (
  connection: ProvisionBackfillSession,
  cursor: string | null,
  size: number,
): Promise<string[]> => {
  const rows = await connection.query(
    `SELECT id::text AS id FROM case_law_decisions
     WHERE ($1::uuid IS NULL OR id > $1::uuid)
     ORDER BY id LIMIT $2`,
    [cursor, size],
  );
  return rows.map((row) => readString(row, "id"));
};

const repairCursorPage = async (
  connection: ProvisionBackfillSession,
  name: "scope-bootstrap" | "state-seed",
): Promise<ProvisionBackfillUnit> =>
  await inTransaction(connection, async () => {
    const previous = await readCursor(connection, name);
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
): Promise<ProvisionBackfillUnit> =>
  await inTransaction(connection, async () => {
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
  });

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

const scopeSeedStep: ProvisionBackfillStep = {
  name: "scope-seed",
  budget: PROVISION_BACKFILL_BUDGET.PAGE,
  readCompletion: async (connection) => {
    const actual = new Set((await readActiveScopes(connection)).map(keyOf));
    const expected = new Set(PROVISION_CITATION_SCOPE_KEYS.map(keyOf));
    return actual.size === expected.size &&
      [...actual].every((key) => expected.has(key))
      ? { type: "complete" }
      : {
          reason: "active provision scopes differ from profiles",
          type: "incomplete",
        };
  },
  advance: async (connection) => {
    // One transition per unit: retirements first, then activations.
    const active = await readActiveScopes(connection);
    const activeKeys = new Set(active.map(keyOf));
    const desired = new Set(PROVISION_CITATION_SCOPE_KEYS.map(keyOf));
    const retiring = active.find((scope) => !desired.has(keyOf(scope)));
    if (retiring !== undefined) {
      return await transitionScope(connection, retiring, "retire");
    }
    const activating = PROVISION_CITATION_SCOPE_KEYS.find(
      (scope) => !activeKeys.has(keyOf(scope)),
    );
    return activating === undefined
      ? Result.ok(undefined)
      : await transitionScope(connection, activating, "activate");
  },
};

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
export const PROVISION_STATE_BACKFILL_STEPS: readonly ProvisionBackfillStep[] =
  [
    cursorStep("scope-bootstrap"),
    scopeSeedStep,
    scopeTransitionsStep,
    cursorStep("state-seed"),
    PROVISION_CITATION_CHECK_STEP,
  ];

type ProvisionStateBackfillOptions = {
  connection: ProvisionBackfillSession;
  /** Epoch milliseconds after which no further unit starts. */
  deadline: number;
  now?: () => number;
};

type ProvisionStateBackfillOutcome =
  | { type: "complete" }
  | { type: "progress"; step: string };

type BackfillRun = Required<ProvisionStateBackfillOptions>;

/**
 * The run from step `index` on. Sequential by construction: a unit starts
 * only after the previous one committed, and the next completion read sees
 * its cursor.
 */
const runFrom = async (
  run: BackfillRun,
  index: number,
  worked: boolean,
): Promise<
  Result<ProvisionStateBackfillOutcome, ProvisionBackfillUnitError>
> => {
  const step = PROVISION_STATE_BACKFILL_STEPS.at(index);
  if (step === undefined) {
    return Result.ok({ type: "complete" });
  }
  if ((await step.readCompletion(run.connection)).type === "complete") {
    return await runFrom(run, index + 1, worked);
  }
  const isScan = step.budget === PROVISION_BACKFILL_BUDGET.WHOLE_RUN;
  if (run.now() >= run.deadline || (isScan && worked)) {
    return Result.ok({ type: "progress", step: step.name });
  }
  const unit = await step.advance(run.connection);
  if (unit.isErr()) {
    return unit;
  }
  return isScan
    ? Result.ok({ type: "progress", step: step.name })
    : await runFrom(run, index, true);
};

/**
 * One bounded run of the backfill. Each unit commits its own work and its
 * cursor together, so a run that stops anywhere is resumed by the next one.
 * A whole-scan unit runs alone: it starts only on a run that has done
 * nothing else, and ends the run.
 */
export const runProvisionStateBackfill = async ({
  connection,
  deadline,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: ProvisionStateBackfillOptions): Promise<
  Result<ProvisionStateBackfillOutcome, ProvisionBackfillUnitError>
> => await runFrom({ connection, deadline, now }, 0, false);
