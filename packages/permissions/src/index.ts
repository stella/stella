import { createAccessControl } from "better-auth/plugins/access";

import {
  BETTER_AUTH_ORGANIZATION_ROLE_GRANTS,
  BETTER_AUTH_ORGANIZATION_STATEMENTS,
} from "@stll/auth-model";
import type { OrganizationRoleName } from "@stll/auth-model";

/**
 * Statement-based permission definitions for Stella.
 *
 * Each key maps to a resource, and its value is an array of
 * allowed actions. Roles are built by selecting a subset of
 * these actions per resource.
 */
export const statements = {
  ...BETTER_AUTH_ORGANIZATION_STATEMENTS,
  workspace: ["read", "create", "update", "delete"],
  contact: ["create", "update", "delete"],
  invoice: ["create", "update", "delete"],
  template: ["use", "create", "update", "delete"],
  styleSet: ["use", "create", "update", "delete"],
  clause: ["create", "update", "delete"],
  entity: ["create", "update", "delete"],
  timeEntry: ["read", "create", "update", "delete", "approve"],
  expense: ["create", "update", "delete"],
  view: ["create", "update", "delete"],
  property: ["create", "update", "delete"],
  playbook: ["create", "update", "delete", "apply", "approve"],
  flow: ["create", "update", "delete", "run", "review"],
  signal: ["create", "resolve", "triage"],
  billingCode: ["create", "update", "delete"],
  rate: ["read", "create", "update", "delete"],
  // todo: add better permissions for chat
  chat: ["create", "update", "delete"],
  organizationSettings: ["update"],
  auditLog: ["read"],
  agentSkill: ["create", "update", "delete", "propose", "comment"],
  firmMemory: ["create", "update"],
  // The organization's case-law question columns and the AI runs that fill
  // them. Organization-scoped like `agentSkill`: one set serves every member,
  // so authoring and running it is a grant of its own rather than a matter
  // permission.
  caseLawResearch: ["create", "update", "delete", "run"],
  // Highlights and comments a reader leaves on a decision or a statute.
  // Private by default, shareable with colleagues, so the mark is
  // organization content rather than a view preference.
  legalReaderAnnotation: ["create", "update", "delete"],
  // A reader's own stored search: their criteria, their matters, capped per
  // user, and audited like any other stored query.
  savedSearch: ["create", "update", "delete"],
  // The member's own link between their account and an outside system: an
  // MCP server they connect, a SharePoint sign-in, an agent client bound to
  // them, a desktop registry key. What the organization permits to be linked
  // at all stays under `organizationSettings`.
  integration: ["create", "update", "delete"],
} as const;

type PermissionMap = {
  [K in keyof typeof statements]: (typeof statements)[K][number][];
};

type StellaPermissionMap = Omit<
  PermissionMap,
  keyof typeof BETTER_AUTH_ORGANIZATION_STATEMENTS
>;

type RequireAtLeastOne<T> = Partial<T> &
  {
    [K in keyof T]-?: Pick<T, K>;
  }[keyof T];

export type PermissionInput = RequireAtLeastOne<PermissionMap>;

export const ac = createAccessControl(statements);

const externalStellaGrants = {
  workspace: ["read"],
  contact: [],
  invoice: [],
  template: [],
  styleSet: [],
  clause: [],
  entity: [],
  timeEntry: [],
  expense: [],
  view: [],
  property: [],
  playbook: [],
  flow: [],
  signal: ["create"],
  billingCode: [],
  rate: [],
  chat: [],
  organizationSettings: [],
  auditLog: [],
  agentSkill: [],
  firmMemory: [],
  caseLawResearch: [],
  legalReaderAnnotation: [],
  savedSearch: [],
  integration: [],
} satisfies StellaPermissionMap;

const internStellaGrants = {
  ...externalStellaGrants,
  template: ["use"],
  styleSet: ["use"],
  timeEntry: ["read", "create", "update"],
  expense: ["create", "update"],
  chat: ["create", "update", "delete"],
  // The same line the time entry, expense and chat grants draw: an intern
  // keeps their own work, so they annotate, store a search, and connect
  // their own account.
  legalReaderAnnotation: ["create", "update", "delete"],
  savedSearch: ["create", "update", "delete"],
  integration: ["create", "update", "delete"],
} satisfies StellaPermissionMap;

const memberStellaGrants = {
  workspace: ["read", "create", "update", "delete"],
  contact: ["create", "update", "delete"],
  invoice: ["create", "update", "delete"],
  template: ["use", "create", "update", "delete"],
  styleSet: ["use", "create", "update", "delete"],
  clause: ["create", "update", "delete"],
  entity: ["create", "update", "delete"],
  timeEntry: ["read", "create", "update", "delete"],
  expense: ["create", "update", "delete"],
  view: ["create", "update", "delete"],
  property: ["create", "update", "delete"],
  playbook: ["create", "update", "delete", "apply"],
  flow: ["create", "update", "delete", "run", "review"],
  signal: ["create", "resolve", "triage"],
  billingCode: ["create", "update", "delete"],
  rate: [],
  chat: ["create", "update", "delete"],
  organizationSettings: [],
  auditLog: [],
  agentSkill: ["create", "update", "delete", "propose", "comment"],
  firmMemory: [],
  // Staff author and run research columns in full, as they do agent skills:
  // the matrix reserves management-only treatment for firm administration
  // (rates, firm memory, the audit log) and for approval actions, not for
  // deleting a peer's work.
  caseLawResearch: ["create", "update", "delete", "run"],
  legalReaderAnnotation: ["create", "update", "delete"],
  savedSearch: ["create", "update", "delete"],
  integration: ["create", "update", "delete"],
} satisfies StellaPermissionMap;

const managementStellaGrants = {
  ...memberStellaGrants,
  timeEntry: ["read", "create", "update", "delete", "approve"],
  playbook: ["create", "update", "delete", "apply", "approve"],
  rate: ["read", "create", "update", "delete"],
  organizationSettings: ["update"],
  auditLog: ["read"],
  firmMemory: ["create", "update"],
} satisfies StellaPermissionMap;

/**
 * The roles that hold `managementStellaGrants`: they administer the firm's
 * shared configuration and content (team skills, rates, firm memory). Code
 * that gates on "admin or owner" reads this list, and so does row-level
 * security, so the role set lives in one place.
 */
export const ORGANIZATION_MANAGEMENT_ROLES = [
  "owner",
  "admin",
] as const satisfies readonly OrganizationRoleName[];

type OrganizationManagementRole =
  (typeof ORGANIZATION_MANAGEMENT_ROLES)[number];

export const isOrganizationManagementRole = (
  role: string,
): role is OrganizationManagementRole =>
  ORGANIZATION_MANAGEMENT_ROLES.some(
    (managementRole) => managementRole === role,
  );

/**
 * Closing a task can decide the workflow review gate that raised it, so a
 * role that edits tasks must also hold the review permission. The task paths
 * rely on this binding rather than checking twice.
 */
type TaskEditWithoutFlowReview<G extends StellaPermissionMap> =
  "update" extends G["entity"][number]
    ? "review" extends G["flow"][number]
      ? never
      : G
    : never;

true satisfies [
  TaskEditWithoutFlowReview<typeof externalStellaGrants>,
  TaskEditWithoutFlowReview<typeof internStellaGrants>,
  TaskEditWithoutFlowReview<typeof memberStellaGrants>,
  TaskEditWithoutFlowReview<typeof managementStellaGrants>,
] extends [never, never, never, never]
  ? true
  : never;

export const roles = {
  owner: ac.newRole({
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.owner,
    ...managementStellaGrants,
  }),
  admin: ac.newRole({
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.admin,
    ...managementStellaGrants,
  }),
  member: ac.newRole({
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.member,
    ...memberStellaGrants,
  }),
  intern: ac.newRole({
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.intern,
    ...internStellaGrants,
  }),
  external: ac.newRole({
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.external,
    ...externalStellaGrants,
  }),
} satisfies Record<OrganizationRoleName, unknown>;
