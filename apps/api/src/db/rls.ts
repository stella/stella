import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

export const stella = p.pgRole("stella").existing();

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
