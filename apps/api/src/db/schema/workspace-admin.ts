import {
  bytea,
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
import type { PracticeJurisdiction } from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";

export const matterCounters = p.pgTable(
  "matter_counters",
  {
    id: pUuid<"matterCounter">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scopeKey: p.varchar("scope_key", { length: 128 }).notNull(),
    lastValue: p.integer("last_value").notNull().default(0),
  },
  (table) => [
    p
      .uniqueIndex("matter_counters_org_scope_uidx")
      .on(table.organizationId, table.scopeKey),
    ...orgPolicies(),
  ],
);

export const documentCounters = p.pgTable(
  "document_counters",
  {
    id: pUuid<"documentCounter">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    lastValue: p.integer("last_value").notNull().default(0),
  },
  (table) => [
    p.uniqueIndex("document_counters_ws_uidx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

export const organizationSettings = p.pgTable(
  "organization_settings",
  {
    id: pUuid<"organizationSettings">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    matterNumberPattern: p
      .varchar("matter_number_pattern", { length: 128 })
      .notNull()
      .default("{SEQ}"),
    matterNumberPadding: p
      .integer("matter_number_padding")
      .notNull()
      .default(3),
    documentStampEnabled: p
      .boolean("document_stamp_enabled")
      .notNull()
      .default(true),
    practiceJurisdictions: jsonb("practice_jurisdictions")
      .$type<PracticeJurisdiction[]>()
      .notNull()
      .default([]),
    /**
     * Per-slug overrides for built-in native tools (e.g. ARES). The
     * effective state of a tool is `overrides[slug] ?? jurisdictionDefault`,
     * where the jurisdiction default is whether the tool's
     * recommended jurisdictions intersect the org's practice
     * jurisdictions. Absent entries mean "use the default".
     */
    nativeToolOverrides: jsonb("native_tool_overrides")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    /**
     * Legacy disable list kept for rolling deploy compatibility. New
     * code reads nativeToolOverrides; keep writes in sync until a later
     * migration can drop this column after all deployed versions no
     * longer read it.
     */
    disabledNativeTools: jsonb("disabled_native_tools")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Encrypted OrgAIConfig JSON (AES-256-GCM). */
    aiConfigEncrypted: bytea("ai_config_encrypted"),
    /** AES-GCM initialization vector for aiConfigEncrypted. */
    aiConfigIv: bytea("ai_config_iv"),
    /** Encrypted DeepL API key (single opaque string, AES-256-GCM). */
    deeplApiKeyEncrypted: bytea("deepl_api_key_encrypted"),
    /** AES-GCM initialization vector for deeplApiKeyEncrypted. */
    deeplApiKeyIv: bytea("deepl_api_key_iv"),
    /** Encrypted web-search provider (Tavily) BYOK key, AES-256-GCM. */
    webSearchApiKeyEncrypted: bytea("web_search_api_key_encrypted"),
    /** AES-GCM initialization vector for webSearchApiKeyEncrypted. */
    webSearchApiKeyIv: bytea("web_search_api_key_iv"),
    /** Encrypted url-fetch provider (Jina) BYOK key, AES-256-GCM. */
    urlFetchApiKeyEncrypted: bytea("url_fetch_api_key_encrypted"),
    /** AES-GCM initialization vector for urlFetchApiKeyEncrypted. */
    urlFetchApiKeyIv: bytea("url_fetch_api_key_iv"),
    /**
     * Whether stella may annotate AI requests with prompt-cache
     * markers (Anthropic `cacheControl`, OpenAI `promptCacheKey`).
     * Controls stella's wire behaviour only — providers may still
     * auto-cache opportunistically; ZDR contracts are the only
     * true server-side disable.
     */
    promptCachingEnabled: p
      .boolean("prompt_caching_enabled")
      .notNull()
      .default(true),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  () => [...orgPolicies()],
);

/**
 * Anonymization allowlist — entries that the detection pipeline
 * should NOT mask. The user marks a detected entity as a false
 * positive (e.g. their own client name signing a contract) and
 * the row lands here; the pipeline removes matches whose
 * canonical surface form is in this list at any of the three
 * applicable scopes (doc, workspace, org).
 *
 * Scope columns mirror the blacklist's NULL-pattern:
 *   - workspaceId NULL AND entityId NULL → org-wide
 *   - workspaceId set, entityId NULL    → workspace-wide
 *   - workspaceId set, entityId set     → single document
 *
 * Doc scope keys on `entityId` (the file's entity) so the
 * allowlist follows the file across version cuts; using
 * `fieldId` would lose the override every time the user saves a
 * new revision.
 */
export const anonymizationAllowlistEntries = p.pgTable(
  "anonymization_allowlist_entries",
  {
    id: pUuid<"anonymizationAllowlistEntry">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      { onDelete: "cascade" },
    ),
    entityId: safeUuid<"entity">("entity_id").references(() => entities.id, {
      onDelete: "cascade",
    }),
    label: p.varchar({ length: 64 }).notNull(),
    canonical: p.varchar({ length: 512 }).notNull(),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("anonymization_allowlist_entries_org_idx").on(table.organizationId),
    p
      .index("anonymization_allowlist_entries_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} is not null`),
    p
      .index("anonymization_allowlist_entries_entity_idx")
      .on(table.entityId)
      .where(sql`${table.entityId} is not null`),
    p
      .uniqueIndex("anonymization_allowlist_entries_org_canonical_uidx")
      .on(table.organizationId, sql`lower(${table.canonical})`)
      .where(sql`${table.workspaceId} is null and ${table.entityId} is null`),
    p
      .uniqueIndex("anonymization_allowlist_entries_ws_canonical_uidx")
      .on(table.workspaceId, sql`lower(${table.canonical})`)
      .where(
        sql`${table.workspaceId} is not null and ${table.entityId} is null`,
      ),
    p
      .uniqueIndex("anonymization_allowlist_entries_entity_canonical_uidx")
      .on(table.entityId, sql`lower(${table.canonical})`)
      .where(sql`${table.entityId} is not null`),
    ...orgPolicies(),
  ],
);

export const anonymizationBlacklistEntries = p.pgTable(
  "anonymization_blacklist_entries",
  {
    id: pUuid<"anonymizationBlacklistEntry">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * When set, the entry is scoped to a single workspace
     * and is only consulted by detection runs for that
     * workspace. NULL means org-wide — the firm-level
     * default catalog the existing settings UI maintains.
     */
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      { onDelete: "cascade" },
    ),
    label: p.varchar({ length: 64 }).notNull(),
    canonical: p.varchar({ length: 512 }).notNull(),
    variants: jsonb().$type<string[]>().notNull().default([]),
    enabled: p.boolean().notNull().default(true),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    updatedBy: p
      .text("updated_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("anonymization_blacklist_entries_org_enabled_idx")
      .on(table.organizationId, table.enabled),
    p
      .index("anonymization_blacklist_entries_workspace_idx")
      .on(table.workspaceId, table.enabled),
    p
      .uniqueIndex("anonymization_blacklist_entries_org_canonical_uidx")
      .on(table.organizationId, sql`lower(${table.canonical})`)
      .where(sql`${table.workspaceId} is null`),
    p
      .uniqueIndex("anonymization_blacklist_entries_ws_canonical_uidx")
      .on(table.workspaceId, sql`lower(${table.canonical})`)
      .where(sql`${table.workspaceId} is not null`),
    ...orgPolicies(),
  ],
);
