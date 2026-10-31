import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

type IntroducedConstraint = OnlineConstraintValidation & {
  introducedBy: string;
};

export const FEATURE_RECOVERY_CONSTRAINTS = [
  {
    tableName: "pending_scout_emissions",
    constraintName:
      "pending_scout_emissions_organization_id_organization_id_fk",
    introducedBy: "20261031200738_signals_flows_enrolments",
  },
  {
    tableName: "pending_scout_emissions",
    constraintName: "pending_scout_emissions_workspace_organization_fk",
    introducedBy: "20261031200738_signals_flows_enrolments",
  },
  {
    tableName: "flow_upload_trigger_intents",
    constraintName: "flow_upload_trigger_intents_definition_org_fk",
    introducedBy: "20261031200738_signals_flows_enrolments",
  },
  {
    tableName: "flow_upload_trigger_intents",
    constraintName: "flow_upload_trigger_intents_entity_ws_fk",
    introducedBy: "20261031200738_signals_flows_enrolments",
  },
  {
    tableName: "flow_upload_trigger_intents",
    constraintName: "flow_upload_trigger_intents_workspace_org_fk",
    introducedBy: "20261031200738_signals_flows_enrolments",
  },
  {
    tableName: "feature_enrolments",
    constraintName: "feature_enrolments_feature_id_check",
    introducedBy: "20261031200738_signals_flows_enrolments",
  },
  {
    tableName: "flow_runs",
    constraintName: "flow_runs_recovery_state_check",
    introducedBy: "20261031201338_flow_recovery_outcomes",
  },
  {
    tableName: "flow_upload_trigger_intents",
    constraintName: "flow_upload_trigger_intents_settlement_check",
    introducedBy: "20261031201338_flow_recovery_outcomes",
  },
  {
    tableName: "document_processing_runs",
    constraintName: "document_processing_runs_deadline_scout_skip_check",
    introducedBy: "20261031201338_flow_recovery_outcomes",
  },
  {
    tableName: "pending_scout_emissions",
    constraintName: "pending_scout_emissions_status_check",
    introducedBy: "20261031201138_feature_recovery_grant_waits",
  },
  {
    tableName: "document_processing_runs",
    constraintName:
      "document_processing_runs_deadline_scout_status_values_check",
    introducedBy: "20261031201138_feature_recovery_grant_waits",
  },
  {
    tableName: "document_processing_runs",
    constraintName: "document_processing_runs_deadline_scout_lifecycle_check",
    introducedBy: "20261031201138_feature_recovery_grant_waits",
  },
] as const satisfies readonly IntroducedConstraint[];

export const RETAINED_ACTIVITY_CONSTRAINTS = [
  {
    tableName: "entities",
    constraintName: "entities_feature_owner_check",
    introducedBy: "20261031202238_retained_activity_feature_ownership",
  },
  {
    tableName: "audit_logs",
    constraintName: "audit_logs_feature_owner_check",
    introducedBy: "20261031202338_retained_audit_feature_ownership",
  },
  {
    tableName: "notifications",
    constraintName: "notifications_feature_owner_check",
    introducedBy: "20261031202438_retained_notification_feature_ownership",
  },
] as const satisfies readonly IntroducedConstraint[];

const validation = (constraint: IntroducedConstraint): OnlineRepair => ({
  introducedBy: constraint.introducedBy,
  name: constraint.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      ...constraint,
      repairName: constraint.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [constraint],
    }),
});

export const FEATURE_RECOVERY_CONSTRAINT_VALIDATIONS =
  FEATURE_RECOVERY_CONSTRAINTS.map(validation);
export const RETAINED_ACTIVITY_CONSTRAINT_VALIDATIONS =
  RETAINED_ACTIVITY_CONSTRAINTS.map(validation);
