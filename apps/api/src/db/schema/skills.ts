import {
  agentSkillPolicies,
  agentSkillResourcePolicies,
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  sql,
  user,
} from "./common";
import {
  AGENT_SKILL_ORIGINS,
  AGENT_SKILL_RESOURCE_KINDS,
  AGENT_SKILL_SCOPES,
} from "./files-views";
import type { AgentSkillResourceKind } from "./files-views";

export const agentSkills = p.pgTable(
  "agent_skills",
  {
    id: pUuid<"agentSkill">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: p.text("scope", { enum: AGENT_SKILL_SCOPES }).notNull(),
    origin: p.text("origin", { enum: AGENT_SKILL_ORIGINS }).notNull(),
    slug: p.varchar({ length: 64 }).notNull(),
    name: p.varchar({ length: 64 }).notNull(),
    description: p.text().notNull(),
    version: p.varchar({ length: 64 }),
    license: p.text(),
    compatibility: p.text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    sourceUrl: p.text("source_url"),
    contentHash: p.varchar("content_hash", { length: 64 }).notNull(),
    body: p.text().notNull(),
    enabled: p.boolean().notNull().default(true),
    // Optional slash-command handle. When set, the skill surfaces in
    // the chat slash menu. Uniqueness is enforced by partial indexes
    // below: team commands are unique per org, private commands are
    // unique per (org, user). Null means "no command" and never
    // collides.
    command: p.varchar({ length: 50 }),
    // Optional hint surfaced to the model so it can decide whether
    // to auto-invoke this skill. When null, the skill is only
    // user-triggered (via slash command, picker, etc.).
    autoInvokeHint: p.text("auto_invoke_hint"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("agent_skills_org_team_slug_uidx")
      .on(table.organizationId, table.slug)
      .where(sql`scope = 'team'`),
    p
      .uniqueIndex("agent_skills_user_private_slug_uidx")
      .on(table.organizationId, table.userId, table.slug)
      .where(sql`scope = 'private'`),
    p.index("agent_skills_org_scope_idx").on(table.organizationId, table.scope),
    p
      .index("agent_skills_org_enabled_idx")
      .on(table.organizationId, table.enabled),
    p.index("agent_skills_user_idx").on(table.userId),
    p
      .uniqueIndex("agent_skills_org_team_command_uidx")
      .on(table.organizationId, table.command)
      .where(sql`scope = 'team' AND command IS NOT NULL`),
    p
      .uniqueIndex("agent_skills_user_private_command_uidx")
      .on(table.organizationId, table.userId, table.command)
      .where(sql`scope = 'private' AND command IS NOT NULL`),
    p
      .index("agent_skills_org_command_idx")
      .on(table.organizationId, table.command)
      .where(sql`command IS NOT NULL`),
    ...agentSkillPolicies(),
  ],
);

export const agentSkillResources = p.pgTable(
  "agent_skill_resources",
  {
    id: pUuid<"agentSkillResource">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    skillId: safeUuid<"agentSkill">("skill_id")
      .notNull()
      .references(() => agentSkills.id, { onDelete: "cascade" }),
    path: p.varchar({ length: 512 }).notNull(),
    kind: p
      .text("kind", { enum: AGENT_SKILL_RESOURCE_KINDS })
      .notNull()
      .$type<AgentSkillResourceKind>(),
    content: p.text().notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("agent_skill_resources_skill_path_uidx")
      .on(table.skillId, table.path),
    p.index("agent_skill_resources_skill_idx").on(table.skillId),
    p
      .index("agent_skill_resources_org_skill_idx")
      .on(table.organizationId, table.skillId),
    ...agentSkillResourcePolicies(),
  ],
);

// -- Usage Entitlements & Ledger --

export const USAGE_ENTITLEMENT_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "paused",
] as const;
export type UsageEntitlementStatus =
  (typeof USAGE_ENTITLEMENT_STATUSES)[number];

export const USAGE_ENTITLEMENT_SOURCES = ["hosted", "manual"] as const;
export type UsageEntitlementSource = (typeof USAGE_ENTITLEMENT_SOURCES)[number];

export const USAGE_ALLOCATION_REASONS = [
  "periodic",
  "addon",
  "manual",
  "promo",
] as const;
export type UsageAllocationReason = (typeof USAGE_ALLOCATION_REASONS)[number];

export const USAGE_ALLOCATION_SOURCES = [
  "hosted_entitlement",
  "hosted_allocation",
  "admin",
  "scheduler",
] as const;
export type UsageAllocationSource = (typeof USAGE_ALLOCATION_SOURCES)[number];

export const USAGE_ACTION_TYPES = [
  "chat",
  "anonymise",
  "doc_review",
  "case_law",
  "background",
] as const;
export type UsageActionType = (typeof USAGE_ACTION_TYPES)[number];

export const USAGE_SERVICE_TIERS = ["standard", "flex", "batch"] as const;
export type UsageServiceTier = (typeof USAGE_SERVICE_TIERS)[number];

export const USAGE_PROVIDER_WEBHOOK_RESULTS = [
  "ok",
  "ignored",
  "error",
] as const;
export type UsageProviderWebhookResult =
  (typeof USAGE_PROVIDER_WEBHOOK_RESULTS)[number];
