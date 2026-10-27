import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type {
  OnlineConstraintValidation,
  OnlineIndexDeclaration,
} from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const REMOVAL_RETRY_INDEX = {
  createSql:
    'CREATE INDEX CONCURRENTLY "case_law_reconciliation_items_kind_due_idx" ON public."case_law_reconciliation_items" (source_id, kind, status, next_attempt_at, id)',
  definitionBody:
    "ON public.case_law_reconciliation_items USING btree (source_id, kind, status, next_attempt_at, id)",
  isUnique: false,
  name: "case_law_reconciliation_items_kind_due_idx",
  tableName: "case_law_reconciliation_items",
} as const satisfies OnlineIndexDeclaration;

export const REMOVAL_RETRY_CONSTRAINT = {
  tableName: "case_law_reconciliation_items",
  constraintName: "case_law_reconciliation_items_kind_values",
} as const satisfies OnlineConstraintValidation;

export const REMOVAL_RETRY_VALIDATION = {
  name: REMOVAL_RETRY_CONSTRAINT.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      ...REMOVAL_RETRY_CONSTRAINT,
      repairName: REMOVAL_RETRY_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [REMOVAL_RETRY_CONSTRAINT],
    }),
} satisfies OnlineRepair;
