import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

export const stella = p.pgRole("stella").existing();

/** Session setting keys set via `set_config` per transaction. */
export const SETTING_WORKSPACE_IDS = "app.workspace_ids";
export const SETTING_ORGANIZATION_ID = "app.organization_id";

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
