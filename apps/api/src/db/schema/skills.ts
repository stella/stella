import {
  agentSkillChildPolicies,
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
  timestamptz,
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
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

/**
 * Immutable snapshots of a skill body. Rows are written by the
 * `record_agent_skill_revision` trigger on every body change, never by
 * application code, so no writer can forget one. Consecutive saves by the
 * same author inside a short window coalesce into the latest revision unless
 * a proposal or comment already anchors to it.
 */
export const agentSkillRevisions = p.pgTable(
  "agent_skill_revisions",
  {
    id: pUuid<"agentSkillRevision">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    skillId: safeUuid<"agentSkill">("skill_id")
      .notNull()
      .references(() => agentSkills.id, { onDelete: "cascade" }),
    revisionNumber: p.integer("revision_number").notNull(),
    body: p.text().notNull(),
    contentHash: p.varchar("content_hash", { length: 64 }).notNull(),
    // Null for system writes (seeding, installs) and after account deletion.
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("agent_skill_revisions_skill_number_uidx")
      .on(table.skillId, table.revisionNumber),
    p
      .index("agent_skill_revisions_org_skill_idx")
      .on(table.organizationId, table.skillId),
    ...agentSkillChildPolicies("agent_skill_revisions", "agent_skill_revision"),
  ],
);

export const AGENT_SKILL_PROPOSAL_STATUSES = [
  "draft",
  "proposed",
  "accepted",
  "rejected",
] as const;
export type AgentSkillProposalStatus =
  (typeof AGENT_SKILL_PROPOSAL_STATUSES)[number];

const AGENT_SKILL_PROPOSAL_STATUS_SQL_VALUES = sql.join(
  AGENT_SKILL_PROPOSAL_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/** Terminal statuses: reached once, by a reviewer, and never left. */
export const DECIDED_AGENT_SKILL_PROPOSAL_STATUSES = [
  "accepted",
  "rejected",
] as const satisfies readonly AgentSkillProposalStatus[];

const DECIDED_AGENT_SKILL_PROPOSAL_STATUS_SQL_VALUES = sql.join(
  DECIDED_AGENT_SKILL_PROPOSAL_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * A proposed body for a skill, branched from a base revision. Accepting a
 * proposal writes its body to the skill (which records a revision) and links
 * that revision back as `resultRevisionId`.
 */
export const agentSkillProposals = p.pgTable(
  "agent_skill_proposals",
  {
    id: pUuid<"agentSkillProposal">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    skillId: safeUuid<"agentSkill">("skill_id")
      .notNull()
      .references(() => agentSkills.id, { onDelete: "cascade" }),
    baseRevisionId:
      safeUuid<"agentSkillRevision">("base_revision_id").notNull(),
    body: p.text().notNull(),
    summary: p.text().notNull().default(""),
    status: p
      .text("status", { enum: AGENT_SKILL_PROPOSAL_STATUSES })
      .notNull()
      .default("draft"),
    authorId: p
      .text("author_id")
      .references(() => user.id, { onDelete: "set null" }),
    reviewerId: p
      .text("reviewer_id")
      .references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamptz("decided_at"),
    resultRevisionId: safeUuid<"agentSkillRevision">("result_revision_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.check(
      "agent_skill_proposals_status_check",
      sql`${table.status} IN (${AGENT_SKILL_PROPOSAL_STATUS_SQL_VALUES})`,
    ),
    p.check(
      "agent_skill_proposals_decision_timing_check",
      sql`(${table.status} IN (${DECIDED_AGENT_SKILL_PROPOSAL_STATUS_SQL_VALUES})) = (${table.decidedAt} IS NOT NULL)`,
    ),
    p.check(
      "agent_skill_proposals_result_check",
      sql`${table.status} = 'accepted' OR ${table.resultRevisionId} IS NULL`,
    ),
    p
      .index("agent_skill_proposals_skill_status_idx")
      .on(table.skillId, table.status),
    p
      .index("agent_skill_proposals_org_skill_idx")
      .on(table.organizationId, table.skillId),
    p.index("agent_skill_proposals_base_revision_idx").on(table.baseRevisionId),
    // Named explicitly: Drizzle's generated names exceed Postgres' 63-byte
    // identifier limit and would be truncated.
    p
      .foreignKey({
        name: "agent_skill_proposals_base_revision_fk",
        columns: [table.baseRevisionId],
        foreignColumns: [agentSkillRevisions.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "agent_skill_proposals_result_revision_fk",
        columns: [table.resultRevisionId],
        foreignColumns: [agentSkillRevisions.id],
      })
      .onDelete("set null"),
    ...agentSkillChildPolicies("agent_skill_proposals", "agent_skill_proposal"),
  ],
);

/**
 * A comment anchored to a character range of one revision (or of a
 * proposal's body when `proposalId` is set). `anchorText` keeps the quoted
 * source so the comment can be re-anchored or shown detached once the text
 * moves on.
 */
export const agentSkillComments = p.pgTable(
  "agent_skill_comments",
  {
    id: pUuid<"agentSkillComment">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    skillId: safeUuid<"agentSkill">("skill_id")
      .notNull()
      .references(() => agentSkills.id, { onDelete: "cascade" }),
    revisionId: safeUuid<"agentSkillRevision">("revision_id")
      .notNull()
      .references(() => agentSkillRevisions.id, { onDelete: "cascade" }),
    proposalId: safeUuid<"agentSkillProposal">("proposal_id").references(
      () => agentSkillProposals.id,
      { onDelete: "cascade" },
    ),
    rangeStart: p.integer("range_start").notNull(),
    rangeEnd: p.integer("range_end").notNull(),
    anchorText: p.text("anchor_text").notNull(),
    body: p.text().notNull(),
    authorId: p
      .text("author_id")
      .references(() => user.id, { onDelete: "set null" }),
    resolvedAt: timestamptz("resolved_at"),
    resolvedBy: p
      .text("resolved_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "agent_skill_comments_range_check",
      sql`${table.rangeStart} >= 0 AND ${table.rangeEnd} >= ${table.rangeStart}`,
    ),
    p
      .index("agent_skill_comments_skill_created_idx")
      .on(table.skillId, table.createdAt),
    p
      .index("agent_skill_comments_org_skill_idx")
      .on(table.organizationId, table.skillId),
    p.index("agent_skill_comments_revision_idx").on(table.revisionId),
    p.index("agent_skill_comments_proposal_idx").on(table.proposalId),
    ...agentSkillChildPolicies("agent_skill_comments", "agent_skill_comment"),
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
  "subagent",
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
