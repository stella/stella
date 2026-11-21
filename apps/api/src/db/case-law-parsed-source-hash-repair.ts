import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type {
  OnlineConstraintValidation,
  OnlineIndexDeclaration,
} from "./online-ddl";
import type {
  OnlineRepair,
  OnlineStepIntroduction,
} from "./online-migration-connection";

export const CASE_LAW_PARSE_PENDING_INDEX = {
  introducedBy: {
    type: "code",
    owner: "src/db/case-law-parsed-source-hash-repair.ts",
  },
  createSql:
    'CREATE INDEX CONCURRENTLY "case_law_decisions_parse_pending_idx" ON public."case_law_decisions" USING btree ("id") WHERE "parsed_source_raw_s3_key" IS DISTINCT FROM "source_raw_s3_key"',
  definitionBody:
    "ON public.case_law_decisions USING btree (id) WHERE ((parsed_source_raw_s3_key)::text IS DISTINCT FROM (source_raw_s3_key)::text)",
  isUnique: false,
  name: "case_law_decisions_parse_pending_idx",
  tableName: "case_law_decisions",
} as const satisfies OnlineIndexDeclaration & {
  introducedBy: OnlineStepIntroduction;
};

export const CASE_LAW_PARSED_SOURCE_CONSTRAINT = {
  tableName: "case_law_decisions",
  constraintName: "case_law_decisions_parsed_source_complete",
} as const satisfies OnlineConstraintValidation;

// Legacy output stays unknown until an actual parse can prove its input.
export const CASE_LAW_PARSED_SOURCE_VALIDATION = {
  introducedBy: "20261022120000_case_law_batch_slots",
  name: CASE_LAW_PARSED_SOURCE_CONSTRAINT.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      ...CASE_LAW_PARSED_SOURCE_CONSTRAINT,
      repairName: CASE_LAW_PARSED_SOURCE_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [CASE_LAW_PARSED_SOURCE_CONSTRAINT],
    }),
} satisfies OnlineRepair;
