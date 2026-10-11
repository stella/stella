import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

const ENTITY_FEATURE_GATE_STATES = [
  "pending",
  "open",
  "legal-lists",
  "missing",
] as const;

export const entityFeatureGateColumns = () => ({
  entityFeatureGate: p
    .text("entity_feature_gate", { enum: ENTITY_FEATURE_GATE_STATES })
    .notNull()
    .default("pending"),
});

export const entityFeatureWorkspaceGateColumns = () => ({
  entityFeatureWorkspaceIds: p
    .uuid("entity_feature_workspace_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
});

export const entityFeatureOrganizationGateColumns = () => ({
  entityFeatureOrganizationIds: p
    .text("entity_feature_organization_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
});

export const entityFeatureGateChecks = (table: {
  entityFeatureGate: p.AnyPgColumn;
}) => [
  p.check(
    "entity_feature_gate_states_check",
    sql`${table.entityFeatureGate} IN (${sql.join(
      ENTITY_FEATURE_GATE_STATES.map((state) => sql`${state}`),
      sql`, `,
    )})`.inlineParams(),
  ),
  p.check(
    "entity_feature_gate_ready_check",
    sql`${table.entityFeatureGate} <> 'pending'`,
  ),
];
