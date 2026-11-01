import { is } from "drizzle-orm";
import { getTableConfig, PgPolicy } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import * as agentAuthSchema from "./agent-auth-schema";
import * as authSchema from "./auth-schema";
import * as schema from "./schema";

/** The table a `pgPolicy(...).link(table)` declaration targets, if any. */
export const linkedPolicyTable = (policy: PgPolicy): unknown =>
  Reflect.get(policy, "_linkedTable");

/**
 * Every policy a schema module declares with `.link(table)`. A linked policy
 * lives beside the feature that owns it rather than inside the table's own
 * declaration; it must be exported so this list (and drizzle-kit) can see it.
 */
export const LINKED_POLICIES: readonly PgPolicy[] = [
  schema,
  authSchema,
  agentAuthSchema,
].flatMap((module) =>
  Object.values(module).filter(
    (value): value is PgPolicy =>
      is(value, PgPolicy) && linkedPolicyTable(value) !== undefined,
  ),
);

/**
 * A table's complete policy set: the policies its declaration lists and every
 * linked policy that targets it. The scoped owner policy installer reads
 * policies only through this owner, so a linked policy is never invisible to
 * it.
 */
export const tablePolicies = (
  table: PgTable,
  linked: readonly PgPolicy[] = LINKED_POLICIES,
): PgPolicy[] => [
  ...getTableConfig(table).policies,
  ...linked.filter((policy) => linkedPolicyTable(policy) === table),
];
