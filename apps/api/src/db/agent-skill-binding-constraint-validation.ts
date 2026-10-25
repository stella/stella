import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const AGENT_SKILL_BINDING_CONSTRAINTS = [
  {
    tableName: "agent_skills",
    constraintName: "agent_skills_single_binding_check",
  },
  {
    tableName: "agent_skills",
    constraintName: "agent_skills_bound_workspace_fk",
  },
  {
    tableName: "agent_skills",
    constraintName: "agent_skills_bound_client_fk",
  },
] as const satisfies readonly OnlineConstraintValidation[];

export const AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS =
  AGENT_SKILL_BINDING_CONSTRAINTS.map(
    (constraint) =>
      ({
        name: constraint.constraintName,
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
