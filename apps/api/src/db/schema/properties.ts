import {
  PROPERTY_ROLES,
  PROPERTY_STATUSES,
  jsonb,
  orgPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  user,
  wsPolicies,
} from "./common";
import type {
  ConditionNode,
  EntityKind,
  PlaybookDefinitionStatus,
  PlaybookPositions,
  PlaybookScope,
  PropertyContent,
  PropertyTool,
} from "./common";
import { workspaces } from "./contacts";

export const properties = p.pgTable(
  "properties",
  {
    id: pUuid<"property">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    status: p.text("status", { enum: PROPERTY_STATUSES }).notNull(),
    content: jsonb().$type<PropertyContent>().notNull(),
    tool: jsonb().$type<PropertyTool>().notNull(),
    system: p.boolean().notNull().default(false),
    kinds: p.varchar({ length: 64 }).array().$type<EntityKind>(),
    // Structural role (see PROPERTY_ROLES): identifies the document-type
    // classifier by identity rather than by the literal name "Document Type".
    // Null for ordinary properties.
    role: p.text("role", { enum: PROPERTY_ROLES }),
    // Correlates a property materialized by a playbook back to the bundle
    // column (its `sourceId`) that produced it, so re-applying matches by
    // identity rather than name: survives renames and never collides across
    // playbooks or with manually-created columns. Null for any property not
    // created by a playbook.
    playbookSourceId: p.uuid("playbook_source_id"),
    playbookDefinitionId: safeUuid<"playbookDefinition">(
      "playbook_definition_id",
    ).references(() => playbookDefinitions.id, { onDelete: "cascade" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("properties_workspace_id_idx").on(table.workspaceId),
    p
      .index("properties_workspace_playbook_definition_idx")
      .on(table.workspaceId, table.playbookDefinitionId),
    p.unique("properties_id_ws_unq").on(table.id, table.workspaceId),
    // At most one document-type classifier per workspace: makes a second
    // classifier (which would make routing ambiguous) structurally impossible.
    p
      .uniqueIndex("properties_ws_document_type_classifier_unq")
      .on(table.workspaceId)
      .where(sql`${table.role} = 'document-type-classifier'`),
    ...wsPolicies(),
  ],
);

export const propertyDependencies = p.pgTable(
  "property_dependencies",
  {
    id: pUuid<"propertyDependency">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    dependsOnPropertyId: safeUuid<"property">(
      "depends_on_property_id",
    ).notNull(),
    condition: jsonb().$type<ConditionNode>(),
  },
  (table) => [
    p
      .uniqueIndex(
        "property_dependencies_property_id_depends_on_property_id_key",
      )
      .on(table.propertyId, table.dependsOnPropertyId),
    p.index("property_dependencies_property_id_idx").on(table.propertyId),
    p
      .index("property_dependencies_depends_on_property_id_idx")
      .on(table.dependsOnPropertyId),
    p.check(
      "property_dependencies_no_self_reference_check",
      sql`${table.propertyId} != ${table.dependsOnPropertyId}`,
    ),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.dependsOnPropertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("restrict"),
    p.index("property_dependencies_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

// -- Playbook definitions --

/**
 * An org-scoped playbook definition: a saved, reusable set of graded
 * Positions. It joins clauses and templates under the org-level
 * knowledge area; runs (materialized columns, findings, redlines) are
 * workspace-scoped and resolved separately. `positions` is the
 * version-tagged JSONB container; `scope` is reserved for later
 * doc-type / counterparty / matter targeting.
 */
export const playbookDefinitions = p.pgTable(
  "playbook_definitions",
  {
    id: pUuid<"playbookDefinition">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    scope: jsonb().$type<PlaybookScope>(),
    positions: jsonb().$type<PlaybookPositions>().notNull(),
    // Advisory approval status (v1): "draft" | "approved". Editing
    // (`update-by-id.ts`) always reverts this to "draft"; approving
    // (`approve.ts`) snapshots the current definition into
    // `playbookDefinitionVersions` and flips it to "approved". Nothing in
    // the run/review path hard-blocks on this — see
    // `PlaybookDefinitionStatus`.
    status: p
      .text("status")
      .notNull()
      .default("draft")
      .$type<PlaybookDefinitionStatus>(),
    approvedAt: p.timestamp("approved_at"),
    approvedBy: p.text("approved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("playbook_definitions_organization_id_idx")
      .on(table.organizationId),
    p
      .index("playbook_definitions_org_created_at_idx")
      .on(table.organizationId, table.createdAt),
    p
      .unique("playbook_definitions_id_org_unq")
      .on(table.id, table.organizationId),
    ...orgPolicies(),
  ],
);

/**
 * Immutable snapshot of a `playbookDefinitions` row taken on each approval
 * (`approve.ts`). Mirrors `clauseVersions`/`templateVersions`: append-only,
 * one row per `(playbookDefinitionId, version)`, never updated in place.
 * `restore-version.ts` reads a row here and copies it back onto the
 * definition as a new draft; it never rewrites this table.
 */
export const playbookDefinitionVersions = p.pgTable(
  "playbook_definition_versions",
  {
    id: pUuid<"playbookDefinitionVersion">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    playbookDefinitionId: safeUuid<"playbookDefinition">(
      "playbook_definition_id",
    ).notNull(),
    version: p.integer().notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    scope: jsonb().$type<PlaybookScope>(),
    positions: jsonb().$type<PlaybookPositions>().notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => [
    p
      .uniqueIndex("playbook_def_versions_def_version_uidx")
      .on(table.playbookDefinitionId, table.version),
    p
      .foreignKey({
        name: "playbook_def_versions_def_fk",
        columns: [table.playbookDefinitionId, table.organizationId],
        foreignColumns: [
          playbookDefinitions.id,
          playbookDefinitions.organizationId,
        ],
      })
      .onDelete("cascade"),
    p
      .index("playbook_def_versions_organization_id_idx")
      .on(table.organizationId),
    ...orgPolicies(),
  ],
);

// -- Document types --

/**
 * An org-owned, editable taxonomy of document TYPES (e.g. "Share
 * Purchase Agreement"). `key` is a stable slug that playbook scopes and
 * run-time gating reference; `label` is the human-facing name shown in
 * the workspace "Document Type" classifier. Seeded from
 * `DEFAULT_DOCUMENT_TYPES` and editable per org. RLS mirrors
 * `playbookDefinitions`.
 */
export const documentTypes = p.pgTable(
  "document_types",
  {
    id: pUuid<"documentType">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: p.varchar({ length: 128 }).notNull(),
    label: p.varchar({ length: 256 }).notNull(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("document_types_org_sort_idx")
      .on(table.organizationId, table.sortOrder),
    p.unique("document_types_org_key_unq").on(table.organizationId, table.key),
    ...orgPolicies(),
  ],
);

// -- Entities --
