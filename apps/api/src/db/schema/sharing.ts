import { shareSpaceAccessCheck, stella, workspaceScopeCheck } from "../rls";
import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  user,
} from "./common";
import { workspaces } from "./contacts";

export const SHARE_SPACE_STATUSES = [
  "draft",
  "publishing",
  "active",
  "revoked",
] as const;

export const SHARE_SPACE_DOWNLOAD_POLICIES = ["blocked", "allowed"] as const;
export const SHARE_RECIPIENT_ROLES = ["viewer", "contributor"] as const;
export const SHARE_RECIPIENT_STATUSES = [
  "invited",
  "verified",
  "revoked",
] as const;
export const SHARE_ITEM_STATUSES = [
  "publishing",
  "ready",
  "failed",
  "withdrawn",
] as const;

const activeShareSpaceCheck = (shareSpaceId: ReturnType<typeof sql>) => sql`(
  ${shareSpaceAccessCheck(shareSpaceId)}
  AND EXISTS (
    SELECT 1
    FROM share_spaces authorized_share_space
    WHERE authorized_share_space.id = ${shareSpaceId}
      AND authorized_share_space.status = 'active'
      AND (
        authorized_share_space.expires_at IS NULL
        OR authorized_share_space.expires_at > CURRENT_TIMESTAMP
      )
  )
)`;

const shareSpacePolicies = () => [
  p.pgPolicy("share_spaces_select", {
    for: "select",
    to: stella,
    using: sql`(
      ${workspaceScopeCheck}
      OR (
        ${shareSpaceAccessCheck(sql`id`)}
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      )
    )`,
  }),
  p.pgPolicy("share_spaces_insert", {
    for: "insert",
    to: stella,
    withCheck: workspaceScopeCheck,
  }),
  p.pgPolicy("share_spaces_update", {
    for: "update",
    to: stella,
    using: workspaceScopeCheck,
    withCheck: workspaceScopeCheck,
  }),
  p.pgPolicy("share_spaces_delete", {
    for: "delete",
    to: stella,
    using: workspaceScopeCheck,
  }),
];

const shareRecipientPolicies = () => [
  p.pgPolicy("share_recipients_select", {
    for: "select",
    to: stella,
    using: sql`(
      ${workspaceScopeCheck}
      OR (
        ${activeShareSpaceCheck(sql`share_space_id`)}
        AND user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
        AND status = 'verified'
      )
    )`,
  }),
  p.pgPolicy("share_recipients_insert", {
    for: "insert",
    to: stella,
    withCheck: workspaceScopeCheck,
  }),
  p.pgPolicy("share_recipients_update", {
    for: "update",
    to: stella,
    using: workspaceScopeCheck,
    withCheck: workspaceScopeCheck,
  }),
  p.pgPolicy("share_recipients_delete", {
    for: "delete",
    to: stella,
    using: workspaceScopeCheck,
  }),
];

const shareItemPolicies = () => [
  p.pgPolicy("share_items_select", {
    for: "select",
    to: stella,
    using: sql`(
      ${workspaceScopeCheck}
      OR (
        ${activeShareSpaceCheck(sql`share_space_id`)}
        AND status = 'ready'
      )
    )`,
  }),
  p.pgPolicy("share_items_insert", {
    for: "insert",
    to: stella,
    withCheck: workspaceScopeCheck,
  }),
  p.pgPolicy("share_items_update", {
    for: "update",
    to: stella,
    using: workspaceScopeCheck,
    withCheck: workspaceScopeCheck,
  }),
  p.pgPolicy("share_items_delete", {
    for: "delete",
    to: stella,
    using: workspaceScopeCheck,
  }),
];

export const shareSpaces = p.pgTable(
  "share_spaces",
  {
    id: pUuid<"shareSpace">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    status: p.text({ enum: SHARE_SPACE_STATUSES }).notNull().default("draft"),
    downloadPolicy: p
      .text("download_policy", { enum: SHARE_SPACE_DOWNLOAD_POLICIES })
      .notNull()
      .default("blocked"),
    /** SHA-256 of the raw invitation secret; the raw value is never persisted. */
    accessTokenHash: p.varchar("access_token_hash", { length: 64 }).notNull(),
    expiresAt: p.timestamp("expires_at", { withTimezone: true }),
    revokedAt: p.timestamp("revoked_at", { withTimezone: true }),
    createdBy: p.text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: p
      .timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: p
      .timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("share_spaces_access_token_hash_uidx")
      .on(table.accessTokenHash),
    p
      .index("share_spaces_workspace_created_id_idx")
      .on(table.workspaceId, table.createdAt, table.id),
    p
      .index("share_spaces_org_workspace_idx")
      .on(table.organizationId, table.workspaceId),
    p
      .unique("share_spaces_id_workspace_org_unq")
      .on(table.id, table.workspaceId, table.organizationId),
    p
      .index("share_spaces_active_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'active'`),
    p.check(
      "share_spaces_revocation_state_check",
      sql`(
        (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)
        OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)
      )`,
    ),
    p.check(
      "share_spaces_access_token_hash_check",
      sql`${table.accessTokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    ...shareSpacePolicies(),
  ],
);

export const shareRecipients = p.pgTable(
  "share_recipients",
  {
    id: pUuid<"shareRecipient">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    shareSpaceId: safeUuid<"shareSpace">("share_space_id").notNull(),
    emailNormalized: p.varchar("email_normalized", { length: 320 }).notNull(),
    /** Kept as durable actor provenance if the Better Auth user is deleted. */
    userId: p.text("user_id"),
    role: p.text({ enum: SHARE_RECIPIENT_ROLES }).notNull().default("viewer"),
    status: p
      .text({ enum: SHARE_RECIPIENT_STATUSES })
      .notNull()
      .default("invited"),
    /** Kept as durable actor provenance if the inviter account is deleted. */
    invitedBy: p.text("invited_by"),
    verifiedAt: p.timestamp("verified_at", { withTimezone: true }),
    revokedAt: p.timestamp("revoked_at", { withTimezone: true }),
    lastAccessAt: p.timestamp("last_access_at", { withTimezone: true }),
    createdAt: p
      .timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: p
      .timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("share_recipients_space_email_uidx")
      .on(table.shareSpaceId, table.emailNormalized),
    p
      .uniqueIndex("share_recipients_space_user_uidx")
      .on(table.shareSpaceId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    p
      .index("share_recipients_workspace_space_idx")
      .on(table.workspaceId, table.shareSpaceId),
    p.index("share_recipients_user_id_idx").on(table.userId),
    p
      .foreignKey({
        columns: [table.shareSpaceId, table.workspaceId, table.organizationId],
        foreignColumns: [
          shareSpaces.id,
          shareSpaces.workspaceId,
          shareSpaces.organizationId,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "share_recipients_email_normalized_check",
      sql`${table.emailNormalized} = lower(trim(${table.emailNormalized}))`,
    ),
    p.check(
      "share_recipients_verification_state_check",
      sql`(
        (${table.status} = 'verified' AND ${table.userId} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'invited' AND ${table.verifiedAt} IS NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)
      )`,
    ),
    ...shareRecipientPolicies(),
  ],
);

export const shareItems = p.pgTable(
  "share_items",
  {
    id: pUuid<"shareItem">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    shareSpaceId: safeUuid<"shareSpace">("share_space_id").notNull(),
    /** Provenance only: copied assets remain valid if the source is later deleted. */
    sourceEntityId: safeUuid<"entity">("source_entity_id").notNull(),
    sourceEntityVersionId: safeUuid<"entityVersion">(
      "source_entity_version_id",
    ).notNull(),
    sourceFieldId: safeUuid<"field">("source_field_id").notNull(),
    displayName: p.varchar("display_name", { length: 512 }).notNull(),
    displayPath: p.varchar("display_path", { length: 2048 }),
    sortOrder: p.integer("sort_order").notNull().default(0),
    status: p
      .text({ enum: SHARE_ITEM_STATUSES })
      .notNull()
      .default("publishing"),
    originalFileName: p
      .varchar("original_file_name", { length: 256 })
      .notNull(),
    originalMimeType: p
      .varchar("original_mime_type", { length: 255 })
      .notNull(),
    originalSizeBytes: p
      .bigint("original_size_bytes", { mode: "number" })
      .notNull(),
    originalSha256Hex: p
      .varchar("original_sha256_hex", { length: 64 })
      .notNull(),
    originalStorageKey: p.text("original_storage_key"),
    displayMimeType: p.varchar("display_mime_type", { length: 255 }),
    displayStorageKey: p.text("display_storage_key"),
    thumbnailStorageKey: p.text("thumbnail_storage_key"),
    versionStamp: p.varchar("version_stamp", { length: 128 }),
    verificationCode: p.varchar("verification_code", { length: 16 }),
    failureCode: p.varchar("failure_code", { length: 64 }),
    publishedAt: p.timestamp("published_at", { withTimezone: true }),
    withdrawnAt: p.timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: p
      .timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: p
      .timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("share_items_space_source_version_uidx")
      .on(table.shareSpaceId, table.sourceEntityVersionId),
    p
      .index("share_items_space_created_id_idx")
      .on(table.shareSpaceId, table.createdAt, table.id),
    p
      .index("share_items_workspace_source_entity_idx")
      .on(table.workspaceId, table.sourceEntityId),
    p
      .foreignKey({
        columns: [table.shareSpaceId, table.workspaceId, table.organizationId],
        foreignColumns: [
          shareSpaces.id,
          shareSpaces.workspaceId,
          shareSpaces.organizationId,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "share_items_original_sha256_check",
      sql`${table.originalSha256Hex} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "share_items_original_size_check",
      sql`${table.originalSizeBytes} >= 0`,
    ),
    p.check(
      "share_items_asset_state_check",
      sql`(
        (${table.status} = 'ready'
          AND ${table.originalStorageKey} IS NOT NULL
          AND ${table.displayStorageKey} IS NOT NULL
          AND ${table.displayMimeType} IS NOT NULL
          AND ${table.publishedAt} IS NOT NULL
          AND ${table.failureCode} IS NULL
          AND ${table.withdrawnAt} IS NULL)
        OR (${table.status} = 'publishing'
          AND ${table.publishedAt} IS NULL
          AND ${table.failureCode} IS NULL
          AND ${table.withdrawnAt} IS NULL)
        OR (${table.status} = 'failed'
          AND ${table.failureCode} IS NOT NULL
          AND ${table.publishedAt} IS NULL
          AND ${table.withdrawnAt} IS NULL)
        OR (${table.status} = 'withdrawn' AND ${table.withdrawnAt} IS NOT NULL)
      )`,
    ),
    ...shareItemPolicies(),
  ],
);
