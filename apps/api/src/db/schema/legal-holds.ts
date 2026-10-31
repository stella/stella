import {
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  timestamptz,
} from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";

export const LEGAL_HOLD_SCOPES = ["matter", "entity"] as const;

export const legalHolds = p.pgTable(
  "legal_holds",
  {
    id: pUuid<"legalHold">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scopeType: p.text("scope_type", { enum: LEGAL_HOLD_SCOPES }).notNull(),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      {
        onDelete: "restrict",
      },
    ),
    entityId: safeUuid<"entity">("entity_id").references(() => entities.id, {
      onDelete: "restrict",
    }),
    reason: p.text("reason").notNull(),
    // Actor identities are durable audit evidence; account erasure must not cascade them.
    placedBy: p.text("placed_by").notNull(),
    placedAt: timestamptz("placed_at").notNull().defaultNow(),
    releasedBy: p.text("released_by"),
    releasedAt: timestamptz("released_at"),
    releaseReason: p.text("release_reason"),
  },
  (table) => [
    p.check(
      "legal_holds_scope_check",
      sql`(${table.scopeType} = 'matter' AND ${table.workspaceId} IS NOT NULL AND ${table.entityId} IS NULL) OR (${table.scopeType} = 'entity' AND ${table.entityId} IS NOT NULL AND ${table.workspaceId} IS NULL)`,
    ),
    p.check("legal_holds_reason_check", sql`${table.reason} ~ '[^[:space:]]'`),
    p.check(
      "legal_holds_release_check",
      sql`(${table.releasedAt} IS NULL AND ${table.releasedBy} IS NULL AND ${table.releaseReason} IS NULL) OR (${table.releasedAt} IS NOT NULL AND ${table.releasedBy} IS NOT NULL AND ${table.releaseReason} IS NOT NULL AND ${table.releaseReason} ~ '[^[:space:]]')`,
    ),
    p
      .index("legal_holds_active_org_idx")
      .on(table.organizationId, table.workspaceId, table.entityId)
      .where(sql`${table.releasedAt} IS NULL`),
    ...orgPolicies(),
    p.pgPolicy("legal_holds_owner_access", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_holds'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_holds'::regclass)`,
    }),
  ],
);
