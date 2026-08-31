import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

export const stella = p.pgRole("stella").existing();

// Narrow write role used only by the case-law ingestion daemon.
// Bootstrapped in 20260516000000_case_law_ingestion_role.
export const stellaIngestion = p.pgRole("stella_ingestion").existing();

// The v0.7.22 case-law reader remains intact for the bounded rollout window.
// Remove it after that release can no longer be deployed or used for rollback.
export const stellaCaseLawReader = p.pgRole("stella_caselaw_reader").existing();

// Read-only role for the public case-law and legislation corpus. Every
// relation is column-restricted by the public-law relation map.
export const stellaPublicLawReader = p
  .pgRole("stella_public_law_reader")
  .existing();

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

export const workspaceCheck = workspaceAccessCheck(sql`workspace_id`);

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

// Turn rows carry the message-like ownership columns needed for constant-time
// tenant filters, then prove that those discriminators match the owning thread.
// The thread join also applies the embedded-data scope, exactly as messages do.
const chatTurnScopeCheck = sql`(
  ${userCheck} AND
  ${organizationCheck} AND
  (workspace_id IS NULL OR ${workspaceCheck}) AND
  EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_turns.thread_id
      AND ct.user_id = chat_turns.user_id
      AND ct.organization_id = chat_turns.organization_id
      AND ct.workspace_id IS NOT DISTINCT FROM chat_turns.workspace_id
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

const userFileScopeCheck = sql`(
  ${userCheck} AND
  ${chatDerivedThreadScopeCheck(sql`user_files.thread_id`)}
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

/**
 * Workspace policies for a table that also holds model-derived content whose
 * provenance can reach outside its own matter. The named `uuid[]` column lists
 * every contributing matter; empty means none, the way a global chat thread
 * embeds no matter data. A non-empty value must stay a subset of the session's
 * accessible matters, exactly as `chat_threads.data_workspace_ids` and
 * `ai_memories.source_data_workspace_ids` enforce, so derived text stops being
 * readable once the actor loses access to a matter that fed it.
 */
export const wsDataScopePolicies = (sourceColumn: string) => {
  const column = sql.raw(sourceColumn);
  const check = sql`(
  ${workspaceCheck} AND
  (
    cardinality(${column}) = 0
    OR ${workspaceArrayCheck(column)}
  )
)`;
  return [
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: check,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: check,
    }),
    p.pgPolicy("workspace_update", {
      for: "update",
      to: stella,
      using: check,
    }),
    p.pgPolicy("workspace_delete", {
      for: "delete",
      to: stella,
      using: check,
    }),
  ];
};

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

const wsOrganizationSelectPolicy = (tableName: string) =>
  p.pgPolicy(`${tableName}_workspace_select`, {
    for: "select",
    to: stella,
    using: workspaceOrganizationCheck,
  });

/**
 * Restrictive denials for the two commands no root-owned table ever exposes to
 * the app role. A restrictive policy is AND-ed with every permissive one, so a
 * later migration that adds a permissive UPDATE/DELETE cannot silently unlock
 * mutation of a row the root writer owns.
 */
const wsOrganizationImmutableWritePolicies = (tableName: string) => [
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

/**
 * Tenant-scoped read access for root-owned history tables. Explicit restrictive
 * write policies keep the rows immutable even if a future permissive policy is
 * added accidentally.
 */
export const wsOrganizationReadOnlyPolicies = (tableName: string) => [
  wsOrganizationSelectPolicy(tableName),
  p.pgPolicy(`${tableName}_no_insert`, {
    as: "restrictive",
    for: "insert",
    to: stella,
    withCheck: sql`false`,
  }),
  ...wsOrganizationImmutableWritePolicies(tableName),
];

/**
 * Root-owned table whose request row is created by the very transaction that
 * causes the work, and whose lifecycle after that insert stays root-writer
 * only.
 *
 * `requestShapeCheck` is the contract: it must pin every caller-controlled
 * request and lifecycle field, so the scoped role can write exactly the one
 * fresh shape the application enqueues and nothing else. It is
 * AND-ed with the same workspace + organization pin the table's read policy
 * uses, and UPDATE/DELETE stay denied, so a tenant can never advance, retry, or
 * re-attribute the row it requested.
 */
export const wsOrganizationScopedRequestPolicies = ({
  insertPolicyName,
  requestShapeCheck,
  tableName,
}: {
  insertPolicyName: string;
  requestShapeCheck: SQL;
  tableName: string;
}) => [
  wsOrganizationSelectPolicy(tableName),
  p.pgPolicy(insertPolicyName, {
    for: "insert",
    to: stella,
    withCheck: sql`(${workspaceOrganizationCheck} AND ${requestShapeCheck})`,
  }),
  ...wsOrganizationImmutableWritePolicies(tableName),
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

/**
 * A reader's own notes on shared material. Rows belong to the organization,
 * but a private one is the author's alone: the organization sees it only
 * once its author shares it, and only the author ever changes or removes it.
 */
export const authoredNotePolicies = () => [
  p.pgPolicy("organization_select", {
    for: "select",
    to: stella,
    using: sql`${organizationCheck} AND (visibility = 'shared' OR ${userCheck})`,
  }),
  p.pgPolicy("author_insert", {
    for: "insert",
    to: stella,
    withCheck: sql`${organizationCheck} AND ${userCheck}`,
  }),
  p.pgPolicy("author_update", {
    for: "update",
    to: stella,
    using: sql`${organizationCheck} AND ${userCheck}`,
  }),
  p.pgPolicy("author_delete", {
    for: "delete",
    to: stella,
    using: sql`${organizationCheck} AND ${userCheck}`,
  }),
];

const organizationOptionalWorkspaceCheck = sql`(
  ${organizationCheck} AND
  (workspace_id IS NULL OR ${workspaceCheck})
)`;

/**
 * Organization-scoped rows whose optional workspace discriminator narrows
 * visibility when present. Global rows remain organization-visible; scoped
 * rows additionally require current workspace authorization.
 */
export const organizationOptionalWorkspacePolicies = (tableName: string) => [
  p.pgPolicy(`${tableName}_scope_select`, {
    for: "select",
    to: stella,
    using: organizationOptionalWorkspaceCheck,
  }),
  p.pgPolicy(`${tableName}_scope_insert`, {
    for: "insert",
    to: stella,
    withCheck: organizationOptionalWorkspaceCheck,
  }),
  p.pgPolicy(`${tableName}_scope_update`, {
    for: "update",
    to: stella,
    using: organizationOptionalWorkspaceCheck,
  }),
  p.pgPolicy(`${tableName}_scope_delete`, {
    for: "delete",
    to: stella,
    using: organizationOptionalWorkspaceCheck,
  }),
];

export const orgReadOnlyPolicies = (tableName: string) => [
  p.pgPolicy(`${tableName}_organization_select`, {
    for: "select",
    to: stella,
    using: organizationCheck,
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

const userOrganizationCheck = sql`(${userCheck} AND ${organizationCheck})`;

/**
 * Rows addressed to one person about one organization's activity.
 *
 * The recipient is the access boundary, but the organization is pinned too:
 * somebody who belongs to several firms reaches only the rows their current
 * session's firm produced, so a handler that forgets the organization filter
 * still cannot leak one firm's activity into another firm's session. The
 * UPDATE policy re-checks on write as well, so a row cannot be moved between
 * recipients or firms.
 */
export const userOrganizationPolicies = () => [
  p.pgPolicy("user_select", {
    for: "select",
    to: stella,
    using: userOrganizationCheck,
  }),
  p.pgPolicy("user_insert", {
    for: "insert",
    to: stella,
    withCheck: userOrganizationCheck,
  }),
  p.pgPolicy("user_update", {
    for: "update",
    to: stella,
    using: userOrganizationCheck,
    withCheck: userOrganizationCheck,
  }),
  p.pgPolicy("user_delete", {
    for: "delete",
    to: stella,
    using: userOrganizationCheck,
  }),
];

export const userFilePolicies = () => [
  p.pgPolicy("user_select", {
    for: "select",
    to: stella,
    using: userFileScopeCheck,
  }),
  p.pgPolicy("user_insert", {
    for: "insert",
    to: stella,
    withCheck: userFileScopeCheck,
  }),
  p.pgPolicy("user_update", {
    for: "update",
    to: stella,
    using: userFileScopeCheck,
    withCheck: userFileScopeCheck,
  }),
  p.pgPolicy("user_delete", {
    for: "delete",
    to: stella,
    using: userFileScopeCheck,
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

/**
 * Row visibility for the public-law reader. Applied only to the relations in
 * the exact public-law column map; a policy without a grant would be dead
 * weight on any other table.
 */
export const publicLawReaderPolicies = () => [
  p.pgPolicy("public_law_reader_access", {
    for: "select",
    to: stellaPublicLawReader,
    using: allowAllRows,
  }),
];

/** Case-law relations retain the v0.7.22 policy during the rollout window. */
export const publicCaseLawReaderPolicies = () => [
  p.pgPolicy("case_law_reader_access", {
    for: "select",
    to: stellaCaseLawReader,
    using: allowAllRows,
  }),
  ...publicLawReaderPolicies(),
];

/**
 * Corpus-upload intents contain object keys for payloads that may have been
 * redacted. They are operational recovery records, never application data:
 * only the ingestion role may read or mutate them; the root scheduler bypasses
 * RLS for bounded cleanup.
 */
export const caseLawIngestionOnlyPolicies = () => [
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

// SharePoint (Microsoft Graph) delegated connections are per user+org, so
// their rows are visible only to the owning user within the active org —
// the same fail-closed shape as mcp_user_connections.
const sharepointConnectionCheck = sql`(
  ${organizationCheck} AND ${userCheck}
)`;

export const sharepointConnectionPolicies = () => [
  p.pgPolicy("sharepoint_connection_select", {
    for: "select",
    to: stella,
    using: sharepointConnectionCheck,
  }),
  p.pgPolicy("sharepoint_connection_insert", {
    for: "insert",
    to: stella,
    withCheck: sharepointConnectionCheck,
  }),
  p.pgPolicy("sharepoint_connection_update", {
    for: "update",
    to: stella,
    using: sharepointConnectionCheck,
  }),
  p.pgPolicy("sharepoint_connection_delete", {
    for: "delete",
    to: stella,
    using: sharepointConnectionCheck,
  }),
];

export const sharepointOAuthStatePolicies = () => [
  p.pgPolicy("sharepoint_oauth_state_select", {
    for: "select",
    to: stella,
    using: sharepointConnectionCheck,
  }),
  p.pgPolicy("sharepoint_oauth_state_insert", {
    for: "insert",
    to: stella,
    withCheck: sharepointConnectionCheck,
  }),
  p.pgPolicy("sharepoint_oauth_state_update", {
    for: "update",
    to: stella,
    using: sharepointConnectionCheck,
  }),
  p.pgPolicy("sharepoint_oauth_state_delete", {
    for: "delete",
    to: stella,
    using: sharepointConnectionCheck,
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

const savedSearchCheck = sql`(
  ${organizationCheck} AND ${userCheck}
)`;

export const savedSearchPolicies = () => [
  p.pgPolicy("saved_search_select", {
    for: "select",
    to: stella,
    using: savedSearchCheck,
  }),
  p.pgPolicy("saved_search_insert", {
    for: "insert",
    to: stella,
    withCheck: savedSearchCheck,
  }),
  p.pgPolicy("saved_search_update", {
    for: "update",
    to: stella,
    using: savedSearchCheck,
    withCheck: savedSearchCheck,
  }),
  p.pgPolicy("saved_search_delete", {
    for: "delete",
    to: stella,
    using: savedSearchCheck,
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

/**
 * Rows that hang off a skill (revisions, proposals, comments) are visible to
 * whoever can see the skill: every org member for team skills, the owner for
 * private ones. `tableName` is needed because the correlated subquery must
 * compare against the child row's own organization column.
 */
const agentSkillChildVisibleCheck = (tableName: string) => sql`(
  ${organizationCheck} AND EXISTS (
    SELECT 1
    FROM agent_skills s
    WHERE s.id = skill_id
      AND s.organization_id = ${sql.raw(tableName)}.organization_id
      AND (s.scope = 'team' OR s.user_id = (SELECT current_setting(
        '${sql.raw(SETTING_USER_ID)}', true
      )))
  )
)`;

/**
 * Revisions are written only by the `record_agent_skill_revision` trigger
 * (SECURITY DEFINER), so the app role gets a select policy and nothing else:
 * with no insert/update/delete policy, row security refuses those outright.
 */
export const agentSkillRevisionPolicies = () => [
  p.pgPolicy("agent_skill_revision_select", {
    for: "select",
    to: stella,
    using: agentSkillChildVisibleCheck("agent_skill_revisions"),
  }),
];

export const agentSkillChildPolicies = (
  tableName: string,
  policyPrefix: string,
) => {
  const visible = agentSkillChildVisibleCheck(tableName);
  return [
    p.pgPolicy(`${policyPrefix}_select`, {
      for: "select",
      to: stella,
      using: visible,
    }),
    p.pgPolicy(`${policyPrefix}_insert`, {
      for: "insert",
      to: stella,
      withCheck: visible,
    }),
    p.pgPolicy(`${policyPrefix}_update`, {
      for: "update",
      to: stella,
      using: visible,
      withCheck: visible,
    }),
    p.pgPolicy(`${policyPrefix}_delete`, {
      for: "delete",
      to: stella,
      using: visible,
    }),
  ];
};

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

// Memory rows are visible only within their scope: org-wide (firm),
// the owning user, or a session-accessible workspace (matter). The
// final clause is the ethical wall — a memory derived from matter
// content (`source_data_workspace_ids`) disappears once the actor
// loses access to any contributing matter, even at user scope.
const aiMemoryWorkspaceCheck = sql`workspace_id IN (
  SELECT aw.authorized_workspace_id
  FROM public.${sql.raw(WORKSPACE_ACCESS_VIEW_NAME)} aw
  WHERE aw.workspace_status <> 'deleting'
)`;

const aiMemorySuggestionCheck = sql`(
  status <> 'suggested'
  OR created_by = (SELECT current_setting(
    '${sql.raw(SETTING_USER_ID)}', true
  ))
)`;

const aiMemoryScopeCheck = sql`(
  ${organizationCheck} AND
  ${aiMemorySuggestionCheck} AND
  (
    scope = 'organization'
    OR (scope = 'workspace' AND ${aiMemoryWorkspaceCheck})
    OR (scope = 'user' AND ${userCheck})
  ) AND
  (
    cardinality(source_data_workspace_ids) = 0
    OR ${workspaceArrayCheck(sql`source_data_workspace_ids`)}
  )
)`;

// Memories are archive-only (status='archived'), never hard-deleted.
// The RESTRICTIVE `false` DELETE policy makes that durable: a
// RESTRICTIVE policy is AND-ed with every permissive one, so a later
// migration adding a permissive DELETE cannot silently unlock removal
// (same pattern as audit_logs).
export const aiMemoryPolicies = () => [
  p.pgPolicy("ai_memory_select", {
    for: "select",
    to: stella,
    using: aiMemoryScopeCheck,
  }),
  p.pgPolicy("ai_memory_insert", {
    for: "insert",
    to: stella,
    withCheck: aiMemoryScopeCheck,
  }),
  p.pgPolicy("ai_memory_update", {
    for: "update",
    to: stella,
    using: aiMemoryScopeCheck,
  }),
  p.pgPolicy("ai_memory_no_delete", {
    as: "restrictive",
    for: "delete",
    to: stella,
    using: denyAllRows,
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

export const chatTurnPolicies = () => [
  p.pgPolicy("chat_turn_select", {
    for: "select",
    to: stella,
    using: chatTurnScopeCheck,
  }),
  p.pgPolicy("chat_turn_insert", {
    for: "insert",
    to: stella,
    withCheck: chatTurnScopeCheck,
  }),
  p.pgPolicy("chat_turn_update", {
    for: "update",
    to: stella,
    using: chatTurnScopeCheck,
    withCheck: chatTurnScopeCheck,
  }),
  p.pgPolicy("chat_turn_delete", {
    for: "delete",
    to: stella,
    using: chatTurnScopeCheck,
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

export const chatThreadPreviewPassagePolicies = () => [
  p.pgPolicy("chat_thread_preview_passage_select", {
    for: "select",
    to: stella,
    using: chatDerivedThreadScopeCheck(
      sql`chat_thread_search_preview_passages.thread_id`,
    ),
  }),
  p.pgPolicy("chat_thread_preview_passage_no_insert", {
    as: "restrictive",
    for: "insert",
    to: stella,
    withCheck: sql`false`,
  }),
  p.pgPolicy("chat_thread_preview_passage_no_update", {
    as: "restrictive",
    for: "update",
    to: stella,
    using: sql`false`,
  }),
  p.pgPolicy("chat_thread_preview_passage_no_delete", {
    as: "restrictive",
    for: "delete",
    to: stella,
    using: sql`false`,
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
