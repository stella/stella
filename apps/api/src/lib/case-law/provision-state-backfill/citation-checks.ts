/**
 * Validation of the NOT VALID CHECKs added to
 * `case_law_provision_citations` by the provision extraction migrations,
 * as the last step of the provision state backfill (a scheduler job, never
 * the migrate phase). Existing rows satisfy them because the checked columns
 * were added NULL.
 *
 * Cost: each VALIDATE reads the whole table, about 65 million rows.
 * PostgreSQL validates each CHECK with a scan of its own either way, so one
 * statement per constraint costs
 * nothing extra and makes every commit a checkpoint: an interrupted run loses
 * at most one scan. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which
 * blocks neither reads nor writes; it waits only on vacuum and other DDL.
 */

import { panic, Result } from "better-result";
import { getTableConfig } from "drizzle-orm/pg-core";

import { caseLawProvisionCitations } from "@/api/db/schema";
import { isRecord } from "@/api/lib/type-guards";

import { inBackfillTransaction, PROVISION_BACKFILL_BUDGET } from "./step";
import type {
  ProvisionBackfillCompletion,
  ProvisionBackfillUnit,
  ProvisionBackfillSession,
  ProvisionBackfillStep,
} from "./step";

const REPAIR_NAME = "case-law-provision-citation-checks";
const TABLE_NAME = "case_law_provision_citations";

const getConstraintNames = () =>
  getTableConfig(caseLawProvisionCitations).checks.map(({ name }) => name);

// A short wait for the lock: vacuum or DDL holding the table means trying
// again on the next run, not queueing behind it.
const VALIDATE_LOCK_TIMEOUT_MS = 10_000;
// One scan of a table of this size reads tens of gigabytes of heap: minutes
// at sequential-read speed. The budget leaves room for a slow disk and stays
// below the scheduler's 30-minute run ceiling, so the statement fails before
// the run is abandoned.
const VALIDATE_STATEMENT_TIMEOUT_MS = 25 * 60_000;

const READ_COMPLETION_SQL = `
  SELECT constraint_state.conname AS name,
    constraint_state.convalidated AS "isValidated"
  FROM pg_catalog.pg_constraint constraint_state
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = constraint_state.conrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_relation.relnamespace
  WHERE table_namespace.nspname = 'public'
    AND table_relation.relname = $1
    AND constraint_state.conname = ANY(string_to_array($2, ','))
`;

/** The first constraint still NOT VALID, in declaration order. */
const readPendingConstraint = async (
  connection: ProvisionBackfillSession,
): Promise<string | undefined> => {
  const constraintNames = getConstraintNames();
  if (constraintNames.length === 0) {
    return panic(`Backfill step ${REPAIR_NAME}: no owned CHECK constraints`);
  }
  const rows = await connection.query(READ_COMPLETION_SQL, [
    TABLE_NAME,
    constraintNames.join(","),
  ]);
  const states = new Map<string, boolean>();
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row["name"] !== "string" ||
      typeof row["isValidated"] !== "boolean"
    ) {
      return panic(
        `Backfill step ${REPAIR_NAME}: constraint state has an invalid shape`,
      );
    }
    states.set(row["name"], row["isValidated"]);
  }
  return constraintNames.find((constraintName) => {
    const isValidated = states.get(constraintName);
    if (isValidated === undefined) {
      return panic(
        `Backfill step ${REPAIR_NAME}: constraint ${constraintName} is missing`,
      );
    }
    return !isValidated;
  });
};

const readCompletion = async (
  connection: ProvisionBackfillSession,
): Promise<ProvisionBackfillCompletion> => {
  const pending = await readPendingConstraint(connection);
  return pending === undefined
    ? { type: "complete" }
    : { reason: `constraint ${pending} is not validated`, type: "incomplete" };
};

const validateOne = async (
  connection: ProvisionBackfillSession,
  constraintName: string,
): Promise<ProvisionBackfillUnit> =>
  await inBackfillTransaction(
    connection,
    {
      lockTimeout: VALIDATE_LOCK_TIMEOUT_MS,
      statementTimeout: VALIDATE_STATEMENT_TIMEOUT_MS,
    },
    async () => {
      await connection.execute(
        `ALTER TABLE public."${TABLE_NAME}" VALIDATE CONSTRAINT "${constraintName}"`,
      );
    },
  );

/** Validates the first CHECK still pending; one full-table scan. */
const validateNext = async (
  connection: ProvisionBackfillSession,
): Promise<ProvisionBackfillUnit> => {
  const pending = await readPendingConstraint(connection);
  return pending === undefined
    ? Result.ok(undefined)
    : await validateOne(connection, pending);
};

export const PROVISION_CITATION_CHECK_STEP: ProvisionBackfillStep = {
  name: REPAIR_NAME,
  budget: PROVISION_BACKFILL_BUDGET.WHOLE_RUN,
  readCompletion,
  advance: validateNext,
};
