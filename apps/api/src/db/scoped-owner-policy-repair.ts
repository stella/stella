import { installPolicy, readMissingPolicies } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";
import { GLOBAL_SCOPE_TABLES, ORG_SCOPE_TABLES } from "./org-scope-registry";
import { scopedOwnerPolicyDefinitions } from "./scoped-owner-policy-definitions";

/** Each catalog change is its own transaction and uses the existing lock retry. */
const policies = scopedOwnerPolicyDefinitions([
  ...new Set(
    [
      ...Object.values(ORG_SCOPE_TABLES),
      ...Object.values(GLOBAL_SCOPE_TABLES),
    ].map(({ table }) => table),
  ),
]);

export const SCOPED_OWNER_POLICIES_REPAIR: OnlineRepair = {
  introducedBy: "20261030195919_org_scoped_system_work",
  name: "scoped-owner-policies",
  readCompletion: async (connection) =>
    (await readMissingPolicies(connection, policies)).length === 0
      ? { type: "complete" }
      : {
          type: "incomplete",
          reason: "Scoped owner policies await installation",
        },
  repair: async (connection, tables) => {
    for (const policy of await readMissingPolicies(connection, policies)) {
      const result = await tables.run({
        target: { tableName: policy.tableName, name: policy.name },
        kind: "index_build",
        work: async (session) => {
          await session.run(installPolicy(policy));
        },
      });
      if (result.type === "deferred") {
        return result;
      }
    }
    return { type: "complete" };
  },
};
