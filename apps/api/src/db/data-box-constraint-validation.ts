import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The checks and foreign key the data-box migrations add NOT VALID; the
 * online phase validates them through the contention gate.
 */
export const DATA_BOX_CONSTRAINTS = [
  {
    tableName: "correspondence",
    constraintName: "correspondence_direction_check",
    introducedBy: "20261101221334_data_box_correspondence",
  },
  {
    tableName: "correspondence",
    constraintName: "correspondence_channel_check",
    introducedBy: "20261101221334_data_box_correspondence",
  },
  {
    tableName: "correspondence",
    constraintName: "correspondence_data_box_check",
    introducedBy: "20261101221334_data_box_correspondence",
  },
  {
    tableName: "organization_settings",
    constraintName: "organization_settings_data_box_ids_check",
    introducedBy: "20261101221334_data_box_correspondence",
  },
  {
    tableName: "correspondence",
    constraintName: "correspondence_source_entity_workspace_fk",
    introducedBy: "20261101221734_correspondence_source_maintenance",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const DATA_BOX_CONSTRAINT_VALIDATIONS = DATA_BOX_CONSTRAINTS.map(
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
