import { chatThreads } from "./chat";
import {
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  user,
  userPolicies,
  workspaceViewTemplatePolicies,
  wsPolicies,
} from "./common";
import type { ViewLayout, ViewTemplateProperty } from "./common";
import { workspaces } from "./contacts";

export const userFiles = p.pgTable(
  "user_files",
  {
    id: pUuid<"userFile">().primaryKey(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fileName: p.varchar("file_name", { length: 512 }).notNull(),
    mimeType: p.varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    sha256Hex: p.varchar("sha256_hex", { length: 64 }).notNull(),
    s3Key: p.text("s3_key").notNull(),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, {
        onDelete: "restrict",
      }),
    thumbnailFileId: p.text("thumbnail_file_id"),
    // ThumbHash-rendered `data:image/png;base64,...` blur of the source
    // image; rendered directly in an <img src> with no client decoder.
    placeholder: p.text("placeholder"),
    scanWarnings: p.text("scan_warnings").array(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.index("user_files_user_created_idx").on(table.userId, table.createdAt),
    p
      .index("user_files_thread_created_idx")
      .on(table.threadId, table.createdAt),
    p.index("user_files_user_hash_idx").on(table.userId, table.sha256Hex),
    p.index("user_files_s3_key_idx").on(table.s3Key),
    ...userPolicies(),
  ],
);

// -- Workspace Views --

export const workspaceViews = p.pgTable(
  "workspace_views",
  {
    id: pUuid<"workspaceView">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    layout: jsonb().$type<ViewLayout>().notNull(),
    position: p.integer().notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("workspace_views_workspace_position_idx")
      .on(table.workspaceId, table.position),
    ...wsPolicies(),
  ],
);

export const workspaceViewTemplates = p.pgTable(
  "workspace_view_templates",
  {
    id: pUuid<"workspaceViewTemplate">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    layout: jsonb().$type<ViewLayout>().notNull(),
    templateProperties: jsonb("template_properties")
      .$type<ViewTemplateProperty[]>()
      .notNull()
      .default([]),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("workspace_view_templates_user_name_uidx")
      .on(table.organizationId, table.userId, table.name),
    p
      .index("workspace_view_templates_user_created_idx")
      .on(table.organizationId, table.userId, table.createdAt),
    ...workspaceViewTemplatePolicies(),
  ],
);

// -- Agent Skills --

export const AGENT_SKILL_SCOPES = ["team", "private"] as const;
export type AgentSkillScope = (typeof AGENT_SKILL_SCOPES)[number];

// `authored` covers skills the user composes directly in the editor
// (no uploaded bundle, no URL import). Migrated `prompt_shortcuts`
// rows also use this origin.
export const AGENT_SKILL_ORIGINS = [
  "authored",
  "bundled",
  "upload",
  "url",
] as const;
export type AgentSkillOrigin = (typeof AGENT_SKILL_ORIGINS)[number];

export const AGENT_SKILL_RESOURCE_KINDS = [
  "asset",
  "knowledge",
  "prompt",
  "reference",
  "script",
  "template",
] as const;
export type AgentSkillResourceKind =
  (typeof AGENT_SKILL_RESOURCE_KINDS)[number];

// Slash-command shape for `agentSkills.command`. Mirrors the legacy
// `prompt_shortcuts.command` constraint so migrated rows remain valid.
export const AGENT_SKILL_COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,48}$/u;
export const RESERVED_AGENT_SKILL_COMMANDS = ["model", "new"] as const;
