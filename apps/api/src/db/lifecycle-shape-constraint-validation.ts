import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The lifecycle shape checks the 2026-11-06 migrations add NOT VALID: which
 * fields each state carries, leases held whole, refresh-token rotation, and
 * the workspace status domain. Validating them makes the shape hold for rows
 * written before the checks existed too.
 */
export const LIFECYCLE_SHAPE_CONSTRAINTS = [
  {
    tableName: "flow_runs",
    constraintName: "flow_runs_state_fields_check",
    introducedBy: "20261106091500_flow_run_state_fields",
  },
  {
    tableName: "flow_run_steps",
    constraintName: "flow_run_steps_state_fields_check",
    introducedBy: "20261106091500_flow_run_state_fields",
  },
  {
    tableName: "scheduler_jobs",
    constraintName: "scheduler_jobs_lease_fields_check",
    introducedBy: "20261106103000_scheduler_job_lease_fields",
  },
  {
    tableName: "oauth_refresh_token",
    constraintName: "oauth_refresh_token_rotation_revokes_check",
    introducedBy: "20261106130000_oauth_refresh_rotation_shape",
  },
  {
    tableName: "oauth_refresh_token",
    constraintName: "oauth_refresh_token_replay_window_check",
    introducedBy: "20261106130000_oauth_refresh_rotation_shape",
  },
  {
    tableName: "oauth_refresh_token",
    constraintName: "oauth_refresh_token_replay_response_check",
    introducedBy: "20261106130000_oauth_refresh_rotation_shape",
  },
  {
    tableName: "workspaces",
    constraintName: "workspaces_status_values_check",
    introducedBy: "20261106133000_workspace_status_values",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const LIFECYCLE_SHAPE_CONSTRAINT_VALIDATIONS =
  LIFECYCLE_SHAPE_CONSTRAINTS.map(
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
