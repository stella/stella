import {
  CORRESPONDENCE_AUTH_RESULTS,
  CORRESPONDENCE_CHANNELS,
  CORRESPONDENCE_DIRECTIONS,
  CORRESPONDENCE_DROP_REASONS,
  CORRESPONDENCE_HANDLING_STATES,
  CORRESPONDENCE_INTAKES,
  CORRESPONDENCE_SCAN_VERDICTS,
  CORRESPONDENCE_SENDER_KINDS,
  CORRESPONDENCE_SENDER_SCOPES,
  type CorrespondenceAddress,
  type CorrespondenceOriginalSignature,
} from "@stll/api-contract/correspondence";

import {
  jsonb,
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  timestamptz,
  user,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";

const FORWARDED_INTAKES = CORRESPONDENCE_INTAKES.filter(
  (intake) => intake !== "direct",
);

const valuesSql = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

export const CORRESPONDENCE_OFFBOARDING_SETTING = {
  userId: "app.correspondence_offboarding_user_id",
  organizationId: "app.correspondence_offboarding_organization_id",
  scope: "app.correspondence_offboarding_scope",
  recordIds: "app.correspondence_offboarding_record_ids",
} as const;

// Resolve the owner through the catalog because deployment login names differ.
const currentUserOwnsCorrespondence = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence'::regclass)`;

const offboardingScopeCheck = sql`(
  current_setting(${sql.raw(`'${CORRESPONDENCE_OFFBOARDING_SETTING.scope}'`)}, true) = 'account'
  or (current_setting(${sql.raw(`'${CORRESPONDENCE_OFFBOARDING_SETTING.scope}'`)}, true) = 'organization'
    and organization_id = current_setting(${sql.raw(`'${CORRESPONDENCE_OFFBOARDING_SETTING.organizationId}'`)}, true))
)`;
const offboardingAssigneeCheck = sql`assignee_id = nullif(current_setting(${sql.raw(`'${CORRESPONDENCE_OFFBOARDING_SETTING.userId}'`)}, true), '')`;

export const correspondence = p.pgTable.withRLS(
  "correspondence",
  {
    id: pUuid<"correspondence">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    direction: p
      .text("direction", { enum: CORRESPONDENCE_DIRECTIONS })
      .notNull(),
    channel: p.text("channel", { enum: CORRESPONDENCE_CHANNELS }).notNull(),
    intake: p.text("intake", { enum: CORRESPONDENCE_INTAKES }).notNull(),
    authenticatedSenderAddress: p
      .text("authenticated_sender_address")
      .notNull(),
    originalSignature:
      jsonb("original_signature").$type<CorrespondenceOriginalSignature>(),
    messageId: p.text("message_id"),
    contentHash: p.varchar("content_hash", { length: 64 }).notNull(),
    dedupKey: p.varchar("dedup_key", { length: 64 }).notNull(),
    from: jsonb("sender").$type<CorrespondenceAddress>().notNull(),
    to: jsonb("recipients_to").$type<CorrespondenceAddress[]>().notNull(),
    cc: jsonb("recipients_cc").$type<CorrespondenceAddress[]>().notNull(),
    subject: p.text("subject").notNull(),
    sentAt: timestamptz("sent_at"),
    receivedAt: timestamptz("received_at").notNull(),
    inReplyTo: p.text("in_reply_to"),
    references: jsonb("references").$type<string[]>().notNull(),
    bodyText: p.text("body_text").notNull(),
    bodyHtml: p.text("body_html"),
    spf: p.text("spf", { enum: CORRESPONDENCE_AUTH_RESULTS }).notNull(),
    dkim: p.text("dkim", { enum: CORRESPONDENCE_AUTH_RESULTS }).notNull(),
    dmarc: p.text("dmarc", { enum: CORRESPONDENCE_AUTH_RESULTS }).notNull(),
    alignedIdentifier: p.text("aligned_identifier"),
    handlingState: p
      .text("handling_state", { enum: CORRESPONDENCE_HANDLING_STATES })
      .notNull()
      .default("new"),
    assigneeId: p
      .text("assignee_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "correspondence_workspace_organization_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    p.unique("correspondence_id_ws_unq").on(table.id, table.workspaceId),
    p
      .uniqueIndex("correspondence_ws_dedup_uidx")
      .on(table.workspaceId, table.dedupKey),
    p
      .index("correspondence_ws_received_idx")
      .on(table.workspaceId, table.receivedAt.desc(), table.id.desc()),
    p
      .index("correspondence_ws_assignee_idx")
      .on(table.workspaceId, table.assigneeId, table.handlingState),
    p
      .index("correspondence_assignee_org_idx")
      .on(table.assigneeId, table.organizationId, table.id)
      .where(sql`${table.assigneeId} is not null`),
    p.check(
      "correspondence_intake_check",
      sql`${table.intake} in (${valuesSql(CORRESPONDENCE_INTAKES)})`,
    ),
    p.check(
      "correspondence_original_signature_check",
      sql`((${table.intake} = 'direct' and ${table.originalSignature} is null) or (${table.intake} in (${valuesSql(FORWARDED_INTAKES)}) and ${table.originalSignature} = '{"status":"unverified"}'::jsonb) or (${table.intake} = 'forwarded_attachment' and ${table.originalSignature}->>'status' = 'verified' and jsonb_typeof(${table.originalSignature}->'domain') = 'string' and length(${table.originalSignature}->>'domain') > 0)) is true`,
    ),
    p.check(
      "correspondence_direction_check",
      sql`${table.direction} in (${valuesSql(CORRESPONDENCE_DIRECTIONS)})`,
    ),
    p.check(
      "correspondence_channel_check",
      sql`${table.channel} in (${valuesSql(CORRESPONDENCE_CHANNELS)})`,
    ),
    p.check(
      "correspondence_handling_check",
      sql`${table.handlingState} in (${valuesSql(CORRESPONDENCE_HANDLING_STATES)})`,
    ),
    p.check(
      "correspondence_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$' and ${table.dedupKey} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "correspondence_auth_check",
      sql`${table.spf} in (${valuesSql(CORRESPONDENCE_AUTH_RESULTS)}) and ${table.dkim} in (${valuesSql(CORRESPONDENCE_AUTH_RESULTS)}) and ${table.dmarc} in (${valuesSql(CORRESPONDENCE_AUTH_RESULTS)})`,
    ),
    p.pgPolicy("correspondence_owner_offboarding_select", {
      for: "select",
      to: "public",
      // UPDATE also checks SELECT visibility of the cleared row. Admit only
      // the current bounded batch, never all unassigned correspondence.
      using: sql`${currentUserOwnsCorrespondence} and (${offboardingAssigneeCheck} or (${table.assigneeId} is null and ${table.id} = any(nullif(current_setting(${sql.raw(`'${CORRESPONDENCE_OFFBOARDING_SETTING.recordIds}'`)}, true), '')::uuid[]))) and ${offboardingScopeCheck}`,
    }),
    p.pgPolicy("correspondence_owner_offboarding_update", {
      for: "update",
      to: "public",
      using: sql`${currentUserOwnsCorrespondence} and ${offboardingAssigneeCheck} and ${offboardingScopeCheck}`,
      withCheck: sql`${currentUserOwnsCorrespondence} and ${table.assigneeId} is null and ${offboardingScopeCheck}`,
    }),
    ...wsOrganizationPolicies("correspondence"),
  ],
);

export const correspondenceFilers = p.pgTable.withRLS(
  "correspondence_filers",
  {
    id: pUuid<"correspondenceFiler">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    correspondenceId: safeUuid<"correspondence">("correspondence_id").notNull(),
    filedByUserId: p
      .text("filed_by_user_id")
      .references(() => user.id, { onDelete: "restrict" }),
    filedByAllowedSenderId: safeUuid<"correspondenceAllowedSender">(
      "filed_by_allowed_sender_id",
    ),
    filedAt: timestamptz("filed_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "correspondence_filers_workspace_organization_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "correspondence_filers_record_workspace_fk",
        columns: [table.correspondenceId, table.workspaceId],
        foreignColumns: [correspondence.id, correspondence.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "correspondence_filers_sender_organization_fk",
        columns: [table.filedByAllowedSenderId, table.organizationId],
        foreignColumns: [
          correspondenceAllowedSenders.id,
          correspondenceAllowedSenders.organizationId,
        ],
      })
      .onDelete("restrict"),
    p
      .uniqueIndex("correspondence_filers_record_user_uidx")
      .on(table.correspondenceId, table.filedByUserId)
      .where(sql`${table.filedByUserId} is not null`),
    p
      .uniqueIndex("correspondence_filers_record_sender_uidx")
      .on(table.correspondenceId, table.filedByAllowedSenderId)
      .where(sql`${table.filedByAllowedSenderId} is not null`),
    p
      .index("correspondence_filers_ws_record_idx")
      .on(table.workspaceId, table.correspondenceId),
    p
      .index("correspondence_filers_user_history_idx")
      .on(table.filedByUserId, table.organizationId, table.workspaceId)
      .where(sql`${table.filedByUserId} is not null`),
    p
      .index("correspondence_filers_sender_history_idx")
      .on(table.filedByAllowedSenderId, table.organizationId, table.workspaceId)
      .where(sql`${table.filedByAllowedSenderId} is not null`),
    p.check(
      "correspondence_filers_actor_check",
      sql`(${table.filedByUserId} is null) <> (${table.filedByAllowedSenderId} is null)`,
    ),
    ...wsOrganizationPolicies("correspondence_filers"),
  ],
);

export const correspondenceAttachments = p.pgTable.withRLS(
  "correspondence_attachments",
  {
    id: pUuid<"correspondenceAttachment">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    correspondenceId: safeUuid<"correspondence">("correspondence_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    ordinal: p.integer("ordinal").notNull(),
    filename: p.text("filename").notNull(),
    mediaType: p.text("media_type").notNull(),
    byteSize: p.integer("byte_size").notNull(),
    scanVerdict: p
      .text("scan_verdict", { enum: CORRESPONDENCE_SCAN_VERDICTS })
      .notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "correspondence_attachments_workspace_organization_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "correspondence_attachments_record_workspace_fk",
        columns: [table.correspondenceId, table.workspaceId],
        foreignColumns: [correspondence.id, correspondence.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "correspondence_attachments_entity_workspace_fk",
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("correspondence_attachments_record_ordinal_uidx")
      .on(table.correspondenceId, table.ordinal),
    p
      .index("correspondence_attachments_ws_record_idx")
      .on(table.workspaceId, table.correspondenceId),
    p.check(
      "correspondence_attachments_size_check",
      sql`${table.byteSize} >= 0 and ${table.ordinal} >= 0`,
    ),
    p.check(
      "correspondence_attachments_scan_check",
      sql`${table.scanVerdict} in (${valuesSql(CORRESPONDENCE_SCAN_VERDICTS)})`,
    ),
    ...wsOrganizationPolicies("correspondence_attachments"),
  ],
);

export const matterInboundAddresses = p.pgTable.withRLS(
  "matter_inbound_addresses",
  {
    id: pUuid<"matterInboundAddress">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    token: p.varchar("token", { length: 128 }).notNull(),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
    revokedBy: p
      .text("revoked_by")
      .references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    p
      .foreignKey({
        name: "matter_inbound_addresses_workspace_organization_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    p.pgPolicy("matter_inbound_addresses_owner_token_lookup", {
      for: "select",
      to: "public",
      using: sql`current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.matter_inbound_addresses'::regclass)) AND ${table.token} = current_setting('app.inbound_token', true)`,
    }),
    p.uniqueIndex("matter_inbound_addresses_token_uidx").on(table.token),
    p
      .uniqueIndex("matter_inbound_addresses_active_uidx")
      .on(table.workspaceId)
      .where(sql`${table.revokedAt} is null`),
    p
      .index("matter_inbound_addresses_ws_created_idx")
      .on(table.workspaceId, table.createdAt.desc()),
    p.pgPolicy("matter_inbound_addresses_owner_lookup", {
      for: "select",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.matter_inbound_addresses'::regclass)`,
    }),
    ...wsOrganizationPolicies("matter_inbound_addresses"),
  ],
);

export const correspondenceAllowedSenders = p.pgTable.withRLS(
  "correspondence_allowed_senders",
  {
    id: pUuid<"correspondenceAllowedSender">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    address: p.text("address").notNull(),
    kind: p.text("kind", { enum: CORRESPONDENCE_SENDER_KINDS }).notNull(),
    scope: p.text("scope", { enum: CORRESPONDENCE_SENDER_SCOPES }).notNull(),
    ownerUserId: p
      .text("owner_user_id")
      .references(() => user.id, { onDelete: "cascade" }),
    approvedBy: p
      .text("approved_by")
      .references(() => user.id, { onDelete: "restrict" }),
    approvedAt: timestamptz("approved_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [
    p
      .foreignKey({
        name: "correspondence_allowed_senders_organization_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .unique("correspondence_allowed_senders_id_org_unq")
      .on(table.id, table.organizationId),
    p
      .uniqueIndex("correspondence_allowed_senders_active_uidx")
      .on(table.organizationId, table.address)
      .where(sql`${table.revokedAt} is null`),
    p
      .index("correspondence_allowed_senders_org_kind_idx")
      .on(table.organizationId, table.kind),
    p
      .index("correspondence_allowed_senders_approver_idx")
      .on(table.approvedBy, table.organizationId, table.id)
      .where(sql`${table.approvedBy} is not null`),
    p.check(
      "correspondence_allowed_senders_kind_check",
      sql`${table.kind} in (${valuesSql(CORRESPONDENCE_SENDER_KINDS)})`,
    ),
    p.check(
      "correspondence_allowed_senders_scope_check",
      sql`${table.scope} in (${valuesSql(CORRESPONDENCE_SENDER_SCOPES)})`,
    ),
    p.check(
      "correspondence_allowed_senders_owner_check",
      sql`(${table.kind} = 'verified_alias') = (${table.ownerUserId} is not null)`,
    ),
    p.check(
      "correspondence_allowed_senders_approval_check",
      sql`${table.kind} <> 'shared_mailbox' or ${table.approvedBy} is not null`,
    ),
    p.pgPolicy("correspondence_allowed_senders_owner_lookup", {
      for: "select",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_allowed_senders'::regclass)`,
    }),
    ...orgPolicies(),
  ],
);

export const correspondenceAllowedSenderMatters = p.pgTable.withRLS(
  "correspondence_allowed_sender_matters",
  {
    id: pUuid<"correspondenceAllowedSenderMatter">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    allowedSenderId:
      safeUuid<"correspondenceAllowedSender">("allowed_sender_id").notNull(),
  },
  (table) => [
    p
      .foreignKey({
        name: "correspondence_allowed_sender_matters_workspace_organization_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "correspondence_allowed_sender_matters_sender_organization_fk",
        columns: [table.allowedSenderId, table.organizationId],
        foreignColumns: [
          correspondenceAllowedSenders.id,
          correspondenceAllowedSenders.organizationId,
        ],
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("correspondence_allowed_sender_matters_sender_ws_uidx")
      .on(table.allowedSenderId, table.workspaceId),
    p
      .index("correspondence_allowed_sender_matters_ws_sender_idx")
      .on(table.workspaceId, table.allowedSenderId),
    p.pgPolicy("correspondence_allowed_sender_matters_owner_lookup", {
      for: "select",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_allowed_sender_matters'::regclass)`,
    }),
    ...wsOrganizationPolicies("correspondence_allowed_sender_matters"),
  ],
);

export const correspondenceDropLogs = p.pgTable.withRLS(
  "correspondence_drop_logs",
  {
    id: pUuid<"correspondenceDropLog">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    senderAddress: p.text("sender_address").notNull(),
    reason: p.text("reason", { enum: CORRESPONDENCE_DROP_REASONS }).notNull(),
    receivedAt: timestamptz("received_at").notNull(),
  },
  (table) => [
    p
      .foreignKey({
        name: "correspondence_drop_logs_workspace_organization_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    p
      .index("correspondence_drop_logs_ws_received_idx")
      .on(table.workspaceId, table.receivedAt.desc(), table.id.desc()),
    p.check(
      "correspondence_drop_logs_reason_check",
      sql`${table.reason} in (${valuesSql(CORRESPONDENCE_DROP_REASONS)})`,
    ),
    ...wsOrganizationPolicies("correspondence_drop_logs"),
  ],
);
