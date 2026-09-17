/**
 * Completion of an online repair whose postcondition is a validated CHECK: the
 * walk is what makes the rows satisfy the constraint, and
 * `pg_constraint.convalidated` is the catalog fact proving they do. Shared by
 * the repairs behind such a constraint, so the read one skips its walk on is
 * the read the deploy and the API's startup gate refuse on.
 */

import { panic } from "better-result";

import { isRecord } from "../lib/type-guards";
import type {
  OnlineMigrationConnection,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const READ_CONSTRAINT_STATE_SQL = `
  SELECT constraint_state.convalidated AS "isValidated"
  FROM pg_catalog.pg_constraint constraint_state
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = constraint_state.conrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_relation.relnamespace
  WHERE table_namespace.nspname = $1
    AND table_relation.relname = $2
    AND constraint_state.conname = $3
`;

type ConstraintCompletionOptions = {
  connection: OnlineMigrationConnection;
  constraintName: string;
  repairName: string;
  tableName: string;
};

export const readConstraintCompletion = async ({
  connection,
  constraintName,
  repairName,
  tableName,
}: ConstraintCompletionOptions): Promise<OnlineRepairCompletion> => {
  const row = (
    await connection.query(READ_CONSTRAINT_STATE_SQL, [
      "public",
      tableName,
      constraintName,
    ])
  ).at(0);
  // The schema migration that adds the constraint runs before this phase, so a
  // constraint that is not there at all is a broken deploy, not work owed.
  if (row === undefined) {
    panic(
      `Online repair ${repairName}: constraint ${constraintName} is missing`,
    );
  }
  if (!isRecord(row) || typeof row["isValidated"] !== "boolean") {
    panic(`Online repair ${repairName}: constraint state has an invalid shape`);
  }
  return row["isValidated"]
    ? { type: "complete" }
    : {
        reason: `constraint ${constraintName} is not validated`,
        type: "incomplete",
      };
};
