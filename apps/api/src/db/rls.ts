import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

export const stella = p.pgRole("stella").existing();

// Narrow write role used only by the case-law ingestion daemon.
// Bootstrapped in 20260516000000_case_law_ingestion_role.
export const stellaIngestion = p.pgRole("stella_ingestion").existing();

/** Session setting keys set via `set_config` per transaction. */
export const SETTING_WORKSPACE_IDS = "app.workspace_ids";
export const SETTING_WORKSPACE_ACCESS_MODE = "app.workspace_access_mode";
export const SETTING_ORGANIZATION_ID = "app.organization_id";
export const SETTING_USER_ID = "app.user_id";

export const WORKSPACE_ACCESS_MODE = {
  explicit: "explicit",
  membership: "membership",
} as const;
export const WORKSPACE_ACCESS_VIEW_NAME = "stella_authorized_workspaces";

// Created by the authorization migration because its owner-evaluated query is
// intentionally outside Drizzle's declarative table model. Registering it as
// existing keeps schema introspection/parity aware of the managed object.
export const stellaAuthorizedWorkspaces = p
  .pgView(WORKSPACE_ACCESS_VIEW_NAME, {
    authorizedWorkspaceId: p.uuid("authorized_workspace_id").notNull(),
    workspaceStatus: p.text("workspace_status"),
  })
  .existing();

/**
 * Explicit mode is used by deliberately narrowed jobs and security tests.
 * The owner-evaluated security-barrier view unions those IDs with the live
 * membership-derived set in membership mode. Explicit IDs stay additive there
 * so a create transaction can authorize its new workspace before inserting
 * workspace_members. The direct array check keeps validated point operations
 * constant-size; when it misses, the planner-visible set lookup can run as a
 * semi-join or hashed subplan once per statement instead of invoking a SQL
 * function for every candidate row.
 */
const workspaceAccessCheck = (workspaceId: SQL) => sql`CASE
  WHEN ${workspaceId} = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          '${sql.raw(SETTING_WORKSPACE_IDS)}', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE ${workspaceId} IN (
    SELECT aw.authorized_workspace_id
    FROM public.${sql.raw(WORKSPACE_ACCESS_VIEW_NAME)} aw
  )
END`;

const workspaceCheck = workspaceAccessCheck(sql`workspace_id`);

/** Check the row's `id` against the transaction workspace authorization.
 * Used by `workspaces`, which scopes on `id` rather than `workspace_id`. */
export const workspaceIdCheck = workspaceAccessCheck(sql`id`);

// Embedded chat data must remain visible only while every contributing
// workspace is still usable. `IS NULL` makes malformed PostgreSQL arrays fail
// closed; array-level NOT NULL constraints do not reject NULL elements.
// Explicit pinned IDs stay additive here exactly as in the scalar check:
// without the pin bypass, sealing a workspace to 'deleting' would hide its
// embedded-data threads from the deletion transaction's own cleanup DELETE,
// leaving rows that break the workspaces FK.
const workspaceArrayCheck = (workspaceIds: SQL) => sql`NOT EXISTS (
  SELECT 1
  FROM pg_catalog.unnest(${workspaceIds}) AS scoped_workspace(workspace_id)
  WHERE scoped_workspace.workspace_id IS NULL
    OR NOT (
      scoped_workspace.workspace_id = ANY(
        COALESCE(
          NULLIF(
            (SELECT pg_catalog.current_setting(
              '${sql.raw(SETTING_WORKSPACE_IDS)}', true
            )),
            ''
          )::uuid[],
          ARRAY[]::uuid[]
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.${sql.raw(WORKSPACE_ACCESS_VIEW_NAME)} aw
        WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
          AND aw.workspace_status <> 'deleting'
      )
    )
)`;

export const organizationCheck = sql`organization_id =
  (SELECT current_setting(
    '${sql.raw(SETTING_ORGANIZATION_ID)}', true
  ))`;

const userCheck = sql`user_id =
  (SELECT current_setting(
    '${sql.raw(SETTING_USER_ID)}', true
  ))`;

const authOrganizationCheck = sql`id =
  (SELECT current_setting(
    '${sql.raw(SETTING_ORGANIZATION_ID)}', true
  ))`;

const authUserVisibleCheck = sql`(
  id = (SELECT current_setting(
    '${sql.raw(SETTING_USER_ID)}', true
  ))
  OR EXISTS (
    SELECT 1
    FROM member m
    WHERE m.user_id = "user".id
      AND m.organization_id = (SELECT current_setting(
        '${sql.raw(SETTING_ORGANIZATION_ID)}', true
      ))
  )
  OR (
    "user".deleted_at IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM task_assignees ta
        JOIN workspaces w ON w.id = ta.workspace_id
        WHERE ta.user_id = "user".id
          AND ${workspaceAccessCheck(sql`ta.workspace_id`)}
          AND w.organization_id = (SELECT current_setting(
            '${sql.raw(SETTING_ORGANIZATION_ID)}', true
          ))
      )
      OR EXISTS (
        SELECT 1
        FROM entities e
        JOIN workspaces w ON w.id = e.workspace_id
        WHERE (e.created_by = "user".id OR e.last_edited_by = "user".id)
          AND ${workspaceAccessCheck(sql`e.workspace_id`)}
          AND w.organization_id = (SELECT current_setting(
            '${sql.raw(SETTING_ORGANIZATION_ID)}', true
          ))
      )
    )
  )
)`;

const allowAllRows = sql`true`;
const denyAllRows = sql`false`;

// `data_workspace_ids` records every workspace whose content is
// embedded in the thread (citations, document excerpts, etc.). The
// empty default means "no workspace data embedded" — true global
// chats. Any non-empty value must be a subset of the session's
// accessible workspaces, which prevents a stored search-summary
// thread from outliving the user's access to a contributing matter.
const chatThreadDataScopeCheck = sql`(
  cardinality(data_workspace_ids) = 0
  OR ${workspaceArrayCheck(sql`data_workspace_ids`)}
)`;

const chatThreadScopeCheck = sql`(
  ${userCheck} AND
  ${organizationCheck} AND
  (workspace_id IS NULL OR ${workspaceCheck}) AND
  ${chatThreadDataScopeCheck}
)`;

// Messages inherit the data scope from their owning thread. RLS on
// `chat_messages` joins `chat_threads` so a leaked global thread
// row cannot expose its messages even if the thread row itself
// somehow becomes readable.
const chatMessageScopeCheck = sql`(
  ${userCheck} AND
  (workspace_id IS NULL OR ${workspaceCheck}) AND
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_messages.thread_id
      AND ct.organization_id = (SELECT current_setting(
        '${sql.raw(SETTING_ORGANIZATION_ID)}', true
      ))
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ${workspaceArrayCheck(sql`ct.data_workspace_ids`)}
      )
  )
)`;

const fileChatThreadScopeCheck = sql`(
  ${userCheck} AND
  ${organizationCheck} AND
  ${workspaceCheck}
)`;

// Per-user mapping of an org-scoped template to its latest chat
// thread. Templates have no workspace, so the scope is user + org.
const templateChatThreadScopeCheck = sql`(
  ${userCheck} AND
  ${organizationCheck}
)`;

// Derived chat tables store only `thread_id` and derive all tenancy
// from their owning thread, so RLS joins `chat_threads` and applies
// the same scope the thread enforces. This is defence in depth:
// some search maintenance reads via the RLS-bypassing root connection
// and filters explicitly, but any stella-role reader is still held to
// the thread's own visibility.
const chatDerivedThreadScopeCheck = (threadIdSql: SQL) => sql`(
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = ${threadIdSql}
      AND ct.user_id = (SELECT current_setting(
        '${sql.raw(SETTING_USER_ID)}', true
      ))
      AND ct.organization_id = (SELECT current_setting(
        '${sql.raw(SETTING_ORGANIZATION_ID)}', true
      ))
      AND (ct.workspace_id IS NULL OR ${workspaceAccessCheck(sql`ct.workspace_id`)})
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ${workspaceArrayCheck(sql`ct.data_workspace_ids`)}
      )
  )
)`;

export const wsPolicies = () => [
  p.pgPolicy("workspace_select", {
    for: "select",
    to: stella,
    using: workspaceCheck,
  }),
  p.pgPolicy("workspace_insert", {
    for: "insert",
    to: stella,
    withCheck: workspaceCheck,
  }),
  p.pgPolicy("workspace_update", {
    for: "update",
    to: stella,
    using: workspaceCheck,
  }),
  p.pgPolicy("workspace_delete", {
    for: "delete",
    to: stella,
    using: workspaceCheck,
  }),
];

const workspaceOrganizationCheck = sql`(
  ${workspaceCheck} AND ${organizationCheck}
)`;

/**
 * Workspace policies for tables that also persist an organization
 * discriminator. Requiring both scopes in every command prevents a valid
 * workspace pin from authorizing a row whose organization_id was corrupted or
 * supplied from another tenant.
 */
export const wsOrganizationPolicies = (tableName: string) => [
  p.pgPolicy(`${tableName}_workspace_select`, {
    for: "select",
    to: stella,
    using: workspaceOrganizationCheck,
  }),
  p.pgPolicy(`${tableName}_workspace_insert`, {
    for: "insert",
    to: stella,
    withCheck: workspaceOrganizationCheck,
  }),
  p.pgPolicy(`${tableName}_workspace_update`, {
    for: "update",
    to: stella,
    using: workspaceOrganizationCheck,
  }),
  p.pgPolicy(`${tableName}_workspace_delete`, {
    for: "delete",
    to: stella,
    using: workspaceOrganizationCheck,
  }),
];

/**
 * Tenant-scoped read access for root-owned history tables. Explicit restrictive
 * write policies keep the rows immutable even if a future permissive policy is
 * added accidentally.
 */
export const wsOrganizationReadOnlyPolicies = (tableName: string) => [
  p.pgPolicy(`${tableName}_workspace_select`, {
    for: "select",
    to: stella,
    using: workspaceOrganizationCheck,
  }),
  p.pgPolicy(`${tableName}_no_insert`, {
    as: "restrictive",
    for: "insert",
    to: stella,
    withCheck: sql`false`,
  }),
  p.pgPolicy(`${tableName}_no_update`, {
    as: "restrictive",
    for: "update",
    to: stella,
    using: sql`false`,
  }),
  p.pgPolicy(`${tableName}_no_delete`, {
    as: "restrictive",
    for: "delete",
    to: stella,
    using: sql`false`,
  }),
];

export const orgPolicies = () => [
  p.pgPolicy("organization_select", {
    for: "select",
    to: stella,
    using: organizationCheck,
  }),
  p.pgPolicy("organization_insert", {
    for: "insert",
    to: stella,
    withCheck: organizationCheck,
  }),
  p.pgPolicy("organization_update", {
    for: "update",
    to: stella,
    using: organizationCheck,
  }),
  p.pgPolicy("organization_delete", {
    for: "delete",
    to: stella,
    using: organizationCheck,
  }),
];

export const userPolicies = () => [
  p.pgPolicy("user_select", {
    for: "select",
    to: stella,
    using: userCheck,
  }),
  p.pgPolicy("user_insert", {
    for: "insert",
    to: stella,
    withCheck: userCheck,
  }),
  p.pgPolicy("user_update", {
    for: "update",
    to: stella,
    using: userCheck,
  }),
  p.pgPolicy("user_delete", {
    for: "delete",
    to: stella,
    using: userCheck,
  }),
];

export const authUserPolicies = () => [
  p.pgPolicy("auth_user_select", {
    for: "select",
    to: stella,
    using: authUserVisibleCheck,
  }),
];

export const authOrganizationPolicies = () => [
  p.pgPolicy("auth_organization_select", {
    for: "select",
    to: stella,
    using: authOrganizationCheck,
  }),
];

export const authMemberPolicies = () => [
  p.pgPolicy("auth_member_select", {
    for: "select",
    to: stella,
    using: organizationCheck,
  }),
  p.pgPolicy("auth_member_update_last_active_workspace", {
    for: "update",
    to: stella,
    using: organizationCheck,
    withCheck: organizationCheck,
  }),
];

export const denyStellaAccessPolicies = () => [
  p.pgPolicy("auth_no_stella_access", {
    for: "all",
    to: stella,
    using: denyAllRows,
    withCheck: denyAllRows,
  }),
];

export const globalCaseLawPolicies = () => [
  p.pgPolicy("case_law_global_access", {
    for: "select",
    to: stella,
    using: allowAllRows,
  }),
  p.pgPolicy("case_law_ingestion_access", {
    for: "all",
    to: stellaIngestion,
    using: allowAllRows,
    withCheck: allowAllRows,
  }),
];

const mcpConnectorVisibleCheck = sql`(
  organization_id IS NULL OR ${organizationCheck}
)`;

export const mcpConnectorPolicies = () => [
  p.pgPolicy("mcp_connector_select", {
    for: "select",
    to: stella,
    using: mcpConnectorVisibleCheck,
  }),
  p.pgPolicy("mcp_connector_insert", {
    for: "insert",
    to: stella,
    withCheck: organizationCheck,
  }),
  p.pgPolicy("mcp_connector_update", {
    for: "update",
    to: stella,
    using: organizationCheck,
  }),
  p.pgPolicy("mcp_connector_delete", {
    for: "delete",
    to: stella,
    using: organizationCheck,
  }),
];

const mcpOAuthClientCheck = sql`(
  ${organizationCheck} AND EXISTS (
  SELECT 1 FROM mcp_connectors mc
  WHERE mc.id = connector_id
  )
)`;

export const mcpOAuthClientPolicies = () => [
  p.pgPolicy("mcp_oauth_client_select", {
    for: "select",
    to: stella,
    using: mcpOAuthClientCheck,
  }),
  p.pgPolicy("mcp_oauth_client_insert", {
    for: "insert",
    to: stella,
    withCheck: mcpOAuthClientCheck,
  }),
  p.pgPolicy("mcp_oauth_client_update", {
    for: "update",
    to: stella,
    using: mcpOAuthClientCheck,
  }),
  p.pgPolicy("mcp_oauth_client_delete", {
    for: "delete",
    to: stella,
    using: mcpOAuthClientCheck,
  }),
];

const mcpUserConnectionCheck = sql`(
  ${organizationCheck} AND ${userCheck}
)`;

export const mcpUserConnectionPolicies = () => [
  p.pgPolicy("mcp_user_connection_select", {
    for: "select",
    to: stella,
    using: mcpUserConnectionCheck,
  }),
  p.pgPolicy("mcp_user_connection_insert", {
    for: "insert",
    to: stella,
    withCheck: mcpUserConnectionCheck,
  }),
  p.pgPolicy("mcp_user_connection_update", {
    for: "update",
    to: stella,
    using: mcpUserConnectionCheck,
  }),
  p.pgPolicy("mcp_user_connection_delete", {
    for: "delete",
    to: stella,
    using: mcpUserConnectionCheck,
  }),
];

export const mcpOAuthStatePolicies = () => [
  p.pgPolicy("mcp_oauth_state_select", {
    for: "select",
    to: stella,
    using: mcpUserConnectionCheck,
  }),
  p.pgPolicy("mcp_oauth_state_insert", {
    for: "insert",
    to: stella,
    withCheck: mcpUserConnectionCheck,
  }),
  p.pgPolicy("mcp_oauth_state_update", {
    for: "update",
    to: stella,
    using: mcpUserConnectionCheck,
  }),
  p.pgPolicy("mcp_oauth_state_delete", {
    for: "delete",
    to: stella,
    using: mcpUserConnectionCheck,
  }),
];

const workspaceViewTemplateCheck = sql`(
  ${organizationCheck} AND ${userCheck}
)`;

export const workspaceViewTemplatePolicies = () => [
  p.pgPolicy("workspace_view_template_select", {
    for: "select",
    to: stella,
    using: workspaceViewTemplateCheck,
  }),
  p.pgPolicy("workspace_view_template_insert", {
    for: "insert",
    to: stella,
    withCheck: workspaceViewTemplateCheck,
  }),
  p.pgPolicy("workspace_view_template_update", {
    for: "update",
    to: stella,
    using: workspaceViewTemplateCheck,
    withCheck: workspaceViewTemplateCheck,
  }),
  p.pgPolicy("workspace_view_template_delete", {
    for: "delete",
    to: stella,
    using: workspaceViewTemplateCheck,
  }),
];

const agentSkillVisibleCheck = sql`(
  ${organizationCheck} AND (scope = 'team' OR ${userCheck})
)`;

const agentSkillInsertCheck = sql`(
  ${organizationCheck} AND ${userCheck}
)`;

const agentSkillResourceVisibleCheck = sql`(
  ${organizationCheck} AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = agent_skill_resources.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        '${sql.raw(SETTING_USER_ID)}', true
      )))
  )
)`;

export const agentSkillPolicies = () => [
  p.pgPolicy("agent_skill_select", {
    for: "select",
    to: stella,
    using: agentSkillVisibleCheck,
  }),
  p.pgPolicy("agent_skill_insert", {
    for: "insert",
    to: stella,
    withCheck: agentSkillInsertCheck,
  }),
  p.pgPolicy("agent_skill_update", {
    for: "update",
    to: stella,
    using: agentSkillVisibleCheck,
    withCheck: agentSkillVisibleCheck,
  }),
  p.pgPolicy("agent_skill_delete", {
    for: "delete",
    to: stella,
    using: agentSkillVisibleCheck,
  }),
];

export const agentSkillResourcePolicies = () => [
  p.pgPolicy("agent_skill_resource_select", {
    for: "select",
    to: stella,
    using: agentSkillResourceVisibleCheck,
  }),
  p.pgPolicy("agent_skill_resource_insert", {
    for: "insert",
    to: stella,
    withCheck: agentSkillResourceVisibleCheck,
  }),
  p.pgPolicy("agent_skill_resource_update", {
    for: "update",
    to: stella,
    using: agentSkillResourceVisibleCheck,
    withCheck: agentSkillResourceVisibleCheck,
  }),
  p.pgPolicy("agent_skill_resource_delete", {
    for: "delete",
    to: stella,
    using: agentSkillResourceVisibleCheck,
  }),
];

export const chatThreadPolicies = () => [
  p.pgPolicy("chat_thread_select", {
    for: "select",
    to: stella,
    using: chatThreadScopeCheck,
  }),
  p.pgPolicy("chat_thread_insert", {
    for: "insert",
    to: stella,
    withCheck: chatThreadScopeCheck,
  }),
  p.pgPolicy("chat_thread_update", {
    for: "update",
    to: stella,
    using: chatThreadScopeCheck,
  }),
  p.pgPolicy("chat_thread_delete", {
    for: "delete",
    to: stella,
    using: chatThreadScopeCheck,
  }),
];

export const chatMessagePolicies = () => [
  p.pgPolicy("chat_message_select", {
    for: "select",
    to: stella,
    using: chatMessageScopeCheck,
  }),
  p.pgPolicy("chat_message_insert", {
    for: "insert",
    to: stella,
    withCheck: chatMessageScopeCheck,
  }),
  p.pgPolicy("chat_message_update", {
    for: "update",
    to: stella,
    using: chatMessageScopeCheck,
  }),
  p.pgPolicy("chat_message_delete", {
    for: "delete",
    to: stella,
    using: chatMessageScopeCheck,
  }),
];

export const chatThreadSearchDocumentPolicies = () => [
  p.pgPolicy("chat_thread_search_document_select", {
    for: "select",
    to: stella,
    using: chatDerivedThreadScopeCheck(
      sql`chat_thread_search_documents.thread_id`,
    ),
  }),
  p.pgPolicy("chat_thread_search_document_insert", {
    for: "insert",
    to: stella,
    withCheck: chatDerivedThreadScopeCheck(
      sql`chat_thread_search_documents.thread_id`,
    ),
  }),
  p.pgPolicy("chat_thread_search_document_update", {
    for: "update",
    to: stella,
    using: chatDerivedThreadScopeCheck(
      sql`chat_thread_search_documents.thread_id`,
    ),
  }),
  p.pgPolicy("chat_thread_search_document_delete", {
    for: "delete",
    to: stella,
    using: chatDerivedThreadScopeCheck(
      sql`chat_thread_search_documents.thread_id`,
    ),
  }),
];

export const chatMessageSearchDocumentPolicies = () => [
  p.pgPolicy("chat_message_search_document_select", {
    for: "select",
    to: stella,
    using: chatDerivedThreadScopeCheck(
      sql`chat_message_search_documents.thread_id`,
    ),
  }),
  p.pgPolicy("chat_message_search_document_insert", {
    for: "insert",
    to: stella,
    withCheck: chatDerivedThreadScopeCheck(
      sql`chat_message_search_documents.thread_id`,
    ),
  }),
  p.pgPolicy("chat_message_search_document_update", {
    for: "update",
    to: stella,
    using: chatDerivedThreadScopeCheck(
      sql`chat_message_search_documents.thread_id`,
    ),
  }),
  p.pgPolicy("chat_message_search_document_delete", {
    for: "delete",
    to: stella,
    using: chatDerivedThreadScopeCheck(
      sql`chat_message_search_documents.thread_id`,
    ),
  }),
];

export const chatThreadCompactionPolicies = () => [
  p.pgPolicy("chat_thread_compaction_select", {
    for: "select",
    to: stella,
    using: chatDerivedThreadScopeCheck(sql`chat_thread_compactions.thread_id`),
  }),
  p.pgPolicy("chat_thread_compaction_insert", {
    for: "insert",
    to: stella,
    withCheck: chatDerivedThreadScopeCheck(
      sql`chat_thread_compactions.thread_id`,
    ),
  }),
  p.pgPolicy("chat_thread_compaction_update", {
    for: "update",
    to: stella,
    using: chatDerivedThreadScopeCheck(sql`chat_thread_compactions.thread_id`),
  }),
  p.pgPolicy("chat_thread_compaction_delete", {
    for: "delete",
    to: stella,
    using: chatDerivedThreadScopeCheck(sql`chat_thread_compactions.thread_id`),
  }),
];

export const fileChatThreadPolicies = () => [
  p.pgPolicy("file_chat_thread_select", {
    for: "select",
    to: stella,
    using: fileChatThreadScopeCheck,
  }),
  p.pgPolicy("file_chat_thread_insert", {
    for: "insert",
    to: stella,
    withCheck: fileChatThreadScopeCheck,
  }),
  p.pgPolicy("file_chat_thread_update", {
    for: "update",
    to: stella,
    using: fileChatThreadScopeCheck,
  }),
  p.pgPolicy("file_chat_thread_delete", {
    for: "delete",
    to: stella,
    using: fileChatThreadScopeCheck,
  }),
];

export const templateChatThreadPolicies = () => [
  p.pgPolicy("template_chat_thread_select", {
    for: "select",
    to: stella,
    using: templateChatThreadScopeCheck,
  }),
  p.pgPolicy("template_chat_thread_insert", {
    for: "insert",
    to: stella,
    withCheck: templateChatThreadScopeCheck,
  }),
  p.pgPolicy("template_chat_thread_update", {
    for: "update",
    to: stella,
    using: templateChatThreadScopeCheck,
  }),
  p.pgPolicy("template_chat_thread_delete", {
    for: "delete",
    to: stella,
    using: templateChatThreadScopeCheck,
  }),
];
