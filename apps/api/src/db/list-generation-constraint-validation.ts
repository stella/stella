import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const INTRODUCED_BY = "20261109180000_list_generation_fact_details";

/**
 * The run producer and candidate fact-detail checks migration
 * 20261109180000_list_generation_fact_details adds NOT VALID. Each only
 * constrains columns that migration adds, so existing rows already pass.
 */
export const LIST_GENERATION_CONSTRAINTS = [
  "legal_list_generation_runs_workspace_organization_fk",
  "legal_list_generation_runs_producer_check",
  "legal_list_generation_runs_item_type_check",
  "legal_list_generation_runs_stella_shape_check",
  "legal_list_generation_runs_error_code_check",
].map((constraintName) => ({
  tableName: "legal_list_generation_runs",
  constraintName,
  introducedBy: INTRODUCED_BY,
}));

export const LIST_GENERATION_CANDIDATE_CONSTRAINTS = [
  "legal_list_generation_candidates_confidence_check",
  "legal_list_generation_candidates_scoring_check",
  "legal_list_generation_candidates_occurred_on_canonical_check",
  "legal_list_generation_candidates_occurred_on_check",
  "legal_list_generation_candidates_fact_details_check",
].map((constraintName) => ({
  tableName: "legal_list_generation_candidates",
  constraintName,
  introducedBy: INTRODUCED_BY,
}));

const ALL_CONSTRAINTS = [
  ...LIST_GENERATION_CONSTRAINTS,
  ...LIST_GENERATION_CANDIDATE_CONSTRAINTS,
] satisfies readonly (OnlineConstraintValidation & { introducedBy: string })[];

export const LIST_GENERATION_CONSTRAINT_VALIDATIONS = ALL_CONSTRAINTS.map(
  (constraint) =>
    ({
      name: constraint.constraintName,
      introducedBy: constraint.introducedBy,
      readCompletion: async (connection) =>
        await readConstraintCompletion({
          connection,
          tableName: constraint.tableName,
          constraintName: constraint.constraintName,
          repairName: constraint.constraintName,
        }),
      repair: async (connection, tables) =>
        await validateOnlineConstraints({
          connection,
          tables,
          constraints: [constraint],
        }),
    }) satisfies OnlineRepair,
);

export const LIST_GENERATION_ONLINE_CONSTRAINTS = ALL_CONSTRAINTS;
