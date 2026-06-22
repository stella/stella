import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

export const stella = p.pgRole("stella").existing();

// Narrow write role used only by the case-law ingestion daemon.
// Bootstrapped in 20260516000000_case_law_ingestion_role.
export const stellaIngestion = p.pgRole("stella_ingestion").existing();

/** Session setting keys set via `set_config` per transaction. */
export const SETTING_WORKSPACE_IDS = "app.workspace_ids";
export const SETTING_ORGANIZATION_ID = "app.organization_id";
export const SETTING_USER_ID = "app.user_id";

/** Workspace IDs array from session.
 *  Wrapped in `(SELECT ...)` so the planner evaluates
 *  `current_setting` once (init plan) instead of per row. */
const wsIdsArray = sql`(SELECT current_setting(
  '${sql.raw(SETTING_WORKSPACE_IDS)}', true
))::uuid[]`;

const workspaceCheck = sql`workspace_id = ANY(${wsIdsArray})`;

/** Check that the row's `id` is in the session workspace IDs.
 *  Used by the `workspaces` table (scopes on `id`, not
 *  `workspace_id`). */
export const workspaceIdCheck = sql`id = ANY(${wsIdsArray})`;

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
  OR data_workspace_ids <@ ${wsIdsArray}
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
        OR ct.data_workspace_ids <@ ${wsIdsArray}
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
      AND (ct.workspace_id IS NULL OR ct.workspace_id = ANY(${wsIdsArray}))
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ct.data_workspace_ids <@ ${wsIdsArray}
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

/**
 * Prompt shortcuts are org-scoped for team shortcuts (all org
 * members can read them) and user-scoped for private ones.
 *
 * SELECT:  org matches AND (team scope OR owned by current user)
 * INSERT:  org matches AND user_id is the current user
 * UPDATE/DELETE: org matches AND (team scope OR owned by current user)
 *   — admin/owner enforcement for team mutations is done at
 *     handler level, not DB level.
 */
const promptShortcutOrgCheck = sql`organization_id = (SELECT current_setting(
  '${sql.raw(SETTING_ORGANIZATION_ID)}', true
))`;

const promptShortcutUserCheck = sql`user_id = (SELECT current_setting(
  '${sql.raw(SETTING_USER_ID)}', true
))`;

const promptShortcutReadWriteCheck = sql`(
  ${promptShortcutOrgCheck} AND (scope = 'team' OR ${promptShortcutUserCheck})
)`;

const promptShortcutInsertCheck = sql`(
  ${promptShortcutOrgCheck} AND ${promptShortcutUserCheck}
)`;

export const promptShortcutPolicies = () => [
  p.pgPolicy("prompt_shortcut_select", {
    for: "select",
    to: stella,
    using: promptShortcutReadWriteCheck,
  }),
  p.pgPolicy("prompt_shortcut_insert", {
    for: "insert",
    to: stella,
    withCheck: promptShortcutInsertCheck,
  }),
  p.pgPolicy("prompt_shortcut_update", {
    for: "update",
    to: stella,
    using: promptShortcutReadWriteCheck,
  }),
  p.pgPolicy("prompt_shortcut_delete", {
    for: "delete",
    to: stella,
    using: promptShortcutReadWriteCheck,
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
