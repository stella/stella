import {
  isNotNull,
  jsonb,
  orgPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  tsvector,
  user,
} from "./common";
import type {
  AnyPgColumn,
  ClauseBody,
  ClauseMetadata,
  TemplateRecipeDefinition,
} from "./common";
import { templates } from "./templates";

export const clauseCategories = p.pgTable(
  "clause_categories",
  {
    id: pUuid<"clauseCategory">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    parentId: safeUuid<"clauseCategory">("parent_id").references(
      (): AnyPgColumn => clauseCategories.id,
      {
        onDelete: "set null",
      },
    ),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("clause_categories_organization_id_idx").on(table.organizationId),
    p
      .index("clause_categories_org_parent_idx")
      .on(table.organizationId, table.parentId),
    ...orgPolicies(),
  ],
);

export const clauses = p.pgTable(
  "clauses",
  {
    id: pUuid<"clause">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    categoryId: safeUuid<"clauseCategory">("category_id").references(
      () => clauseCategories.id,
      {
        onDelete: "set null",
      },
    ),
    title: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    usageNotes: p.text("usage_notes"),
    language: p.varchar({ length: 10 }),
    body: jsonb().$type<ClauseBody>().notNull(),
    metadata: jsonb().$type<ClauseMetadata | null>(),
    searchVector: tsvector("search_vector"),
    currentVersion: p.integer("current_version").notNull().default(1),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("clauses_organization_id_idx").on(table.organizationId),
    p
      .index("clauses_org_category_idx")
      .on(table.organizationId, table.categoryId),
    p
      .index("clauses_org_created_at_idx")
      .on(table.organizationId, table.createdAt),
    p.index("clauses_search_vector_gin_idx").using("gin", table.searchVector),
    p.unique("clauses_id_org_unq").on(table.id, table.organizationId),
    ...orgPolicies(),
  ],
);

export const clauseVariants = p.pgTable(
  "clause_variants",
  {
    id: pUuid<"clauseVariant">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    clauseId: safeUuid<"clause">("clause_id").notNull(),
    label: p.varchar({ length: 256 }).notNull(),
    body: jsonb().$type<ClauseBody>().notNull(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("clause_variants_clause_id_idx").on(table.clauseId),
    p
      .foreignKey({
        columns: [table.clauseId, table.organizationId],
        foreignColumns: [clauses.id, clauses.organizationId],
      })
      .onDelete("cascade"),
    p.index("clause_variants_organization_id_idx").on(table.organizationId),
    ...orgPolicies(),
  ],
);

export const clauseVersions = p.pgTable(
  "clause_versions",
  {
    id: pUuid<"clauseVersion">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    clauseId: safeUuid<"clause">("clause_id").notNull(),
    version: p.integer().notNull(),
    body: jsonb().$type<ClauseBody>().notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("clause_versions_clause_version_uidx")
      .on(table.clauseId, table.version),
    p
      .foreignKey({
        columns: [table.clauseId, table.organizationId],
        foreignColumns: [clauses.id, clauses.organizationId],
      })
      .onDelete("cascade"),
    p.index("clause_versions_organization_id_idx").on(table.organizationId),
    ...orgPolicies(),
  ],
);

/**
 * Saved structural-block recipes: a named, org-wide snapshot of
 * pre-configured template fields (optionally wrapped in a `{{#each}}`
 * loop) that can be inserted into any template in one click.
 */
export const templateRecipes = p.pgTable(
  "template_recipes",
  {
    id: pUuid<"templateRecipe">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    definition: jsonb().$type<TemplateRecipeDefinition>().notNull(),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_recipes_organization_id_idx").on(table.organizationId),
    p
      .index("template_recipes_organization_id_name_idx")
      .on(table.organizationId, table.name),
    ...orgPolicies(),
  ],
);

export const templateClauses = p.pgTable(
  "template_clauses",
  {
    id: pUuid<"templateClause">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    templateId: safeUuid<"template">("template_id").notNull(),
    clauseId: safeUuid<"clause">("clause_id").references(() => clauses.id, {
      onDelete: "set null",
    }),
    clauseVariantId: safeUuid<"clauseVariant">("clause_variant_id").references(
      () => clauseVariants.id,
      {
        onDelete: "set null",
      },
    ),
    /** Label snapshot taken at link time. Survives variant deletion
     *  (the FK nulls `clauseVariantId`) so dangling variant links can
     *  be surfaced instead of silently falling back to the clause. */
    clauseVariantLabel: p.varchar("clause_variant_label", { length: 256 }),
    clauseVersionId: safeUuid<"clauseVersion">("clause_version_id").references(
      () => clauseVersions.id,
      {
        onDelete: "set null",
      },
    ),
    slotName: p.varchar("slot_name", { length: 128 }),
    sortOrder: p.integer("sort_order").notNull().default(0),
    insertedAt: p.timestamp("inserted_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_clauses_template_id_idx").on(table.templateId),
    p.index("template_clauses_clause_id_idx").on(table.clauseId),
    p
      .uniqueIndex("template_clauses_template_slot_uidx")
      .on(table.templateId, table.slotName)
      .where(isNotNull(table.slotName)),
    p
      .foreignKey({
        columns: [table.templateId, table.organizationId],
        foreignColumns: [templates.id, templates.organizationId],
      })
      .onDelete("cascade"),
    p.index("template_clauses_organization_id_idx").on(table.organizationId),
    ...orgPolicies(),
  ],
);

// -- Template Fills (analytics) --

export const templateFills = p.pgTable(
  "template_fills",
  {
    id: pUuid<"templateFill">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    templateId: safeUuid<"template">("template_id").references(
      () => templates.id,
      { onDelete: "set null" },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    format: p.text().notNull(),
    status: p.text().notNull(),
    unmatchedCount: p.integer("unmatched_count").notNull().default(0),
    unusedCount: p.integer("unused_count").notNull().default(0),
    structureErrors: jsonb("structure_errors").$type<
      { message: string; paragraphIndex: number; directive: string }[] | null
    >(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_fills_organization_id_idx").on(table.organizationId),
    p
      .index("template_fills_org_created_at_idx")
      .on(table.organizationId, table.createdAt),
    p
      .index("template_fills_org_template_idx")
      .on(table.organizationId, table.templateId),
    ...orgPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Global tables (no organizationId)
// ---------------------------------------------------------------------------
