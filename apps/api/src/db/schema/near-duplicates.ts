import { sql } from "drizzle-orm";

import { SIGNATURE_LENGTH } from "@/api/lib/near-duplicate/minhash";

import {
  entityFeatureGateChecks,
  entityFeatureGateColumns,
  entityFeatureWorkspaceGateColumns,
} from "../entity-feature-gate-columns";
import {
  bytea,
  organization,
  p,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  timestamptz,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { entities, entityVersions } from "./entities";

const SIGNATURE_BYTES = SIGNATURE_LENGTH * 4;

/**
 * MinHash signature of a document version's extracted text, seeded per
 * organization; see `@/api/lib/near-duplicate/minhash`.
 */
export const entityVersionMinhashSignatures = p.pgTable(
  "entity_version_minhash_signatures",
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureWorkspaceGateColumns(),
    entityVersionId:
      safeUuid<"entityVersion">("entity_version_id").primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    signature: bytea("signature").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p
      .foreignKey({
        columns: [table.entityVersionId],
        foreignColumns: [entityVersions.id],
        name: "entity_version_minhash_signatures_version_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "entity_version_minhash_signatures_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "entity_version_minhash_signatures_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .index("entity_version_minhash_signatures_entity_workspace_idx")
      .on(table.entityId, table.workspaceId),
    p
      .index("entity_version_minhash_signatures_workspace_organization_idx")
      .on(table.workspaceId, table.organizationId),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "entity_version_minhash_signatures_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "entity_version_minhash_signatures_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p.check(
      "entity_version_minhash_signatures_length_check",
      sql`octet_length(${table.signature}) = ${sql.raw(String(SIGNATURE_BYTES))}`,
    ),
    ...wsOrganizationPolicies("entity_version_minhash_signatures", {
      columns: table,
      references: new Map([
        [
          table.entityVersionId,
          { target: "entity_versions", kind: "owned-content" },
        ],
        [table.entityId, { target: "entities", kind: "owned-content" }],
      ]),
    }),
  ],
);

/** One LSH band key per band of a signature; candidates share a key. */
export const entityVersionMinhashBands = p.pgTable(
  "entity_version_minhash_bands",
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureWorkspaceGateColumns(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    bandKey: p.bigint("band_key", { mode: "bigint" }).notNull(),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p.primaryKey({
      name: "entity_version_minhash_bands_pk",
      columns: [table.entityVersionId, table.bandKey],
    }),
    p
      .foreignKey({
        columns: [table.entityVersionId],
        foreignColumns: [entityVersionMinhashSignatures.entityVersionId],
        name: "entity_version_minhash_bands_signature_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "entity_version_minhash_bands_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "entity_version_minhash_bands_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .index("entity_version_minhash_bands_lookup_idx")
      .on(table.workspaceId, table.bandKey),
    p
      .index("entity_version_minhash_bands_entity_workspace_idx")
      .on(table.entityId, table.workspaceId),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "entity_version_minhash_bands_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "entity_version_minhash_bands_entity_workspace_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("entity_version_minhash_bands", {
      columns: table,
      references: new Map([
        [
          table.entityVersionId,
          { target: "entity_versions", kind: "owned-content" },
        ],
        [table.entityId, { target: "entities", kind: "owned-content" }],
      ]),
    }),
  ],
);
