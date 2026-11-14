import {
  BETTER_AUTH_ORGANIZATION_ROLE_GRANTS,
  BETTER_AUTH_ORGANIZATION_STATEMENTS,
  ORGANIZATION_ROLE_NAMES,
} from "@stll/auth-model";
import type { OrganizationRoleName } from "@stll/auth-model";

// What each role may do, as plain data with no auth library behind it, so
// every client (the web, the native apps) decides what to offer by the same
// grants the server enforces. `index.ts` builds the server's access control
// from these.

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
  // A copy of everything the organization stores, for backup and
  // portability. Management-only: the archive spans every client matter.
  dataExport: ["create", "read"],
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
  // A user's own search history: what they searched for and opened, private
  // to them. Held by every role, an external collaborator included: it is a
  // trace of their own reading that nobody else sees, not work they leave in
  // the organization.
  searchHistory: ["read", "create", "delete"],
  // The member's own link between their account and an outside system: an
  // MCP server they connect, a SharePoint sign-in, an agent client bound to
  // them, a desktop registry key. What the organization permits to be linked
  // at all stays under `organizationSettings`.
  integration: ["create", "update", "delete"],
  // Internal conflict-of-interest checks. Running one searches every matter
  // of the firm, including matters the runner cannot open, so it is a grant
  // of its own; reviewing (waiving a conflict, clearing a potential one) is
  // the four-eyes half and stays with firm management.
  conflictCheck: ["run", "review"],
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
  dataExport: [],
  agentSkill: [],
  firmMemory: [],
  caseLawResearch: [],
  legalReaderAnnotation: [],
  savedSearch: [],
  searchHistory: ["read", "create", "delete"],
  integration: [],
  conflictCheck: [],
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
  dataExport: [],
  agentSkill: ["create", "update", "delete", "propose", "comment"],
  firmMemory: [],
  // Staff author and run research columns in full, as they do agent skills:
  // the matrix reserves management-only treatment for firm administration
  // (rates, firm memory, the audit log) and for approval actions, not for
  // deleting a peer's work.
  caseLawResearch: ["create", "update", "delete", "run"],
  legalReaderAnnotation: ["create", "update", "delete"],
  savedSearch: ["create", "update", "delete"],
  searchHistory: ["read", "create", "delete"],
  integration: ["create", "update", "delete"],
  conflictCheck: ["run"],
} satisfies StellaPermissionMap;

const managementStellaGrants = {
  ...memberStellaGrants,
  timeEntry: ["read", "create", "update", "delete", "approve"],
  playbook: ["create", "update", "delete", "apply", "approve"],
  rate: ["read", "create", "update", "delete"],
  organizationSettings: ["update"],
  auditLog: ["read"],
  dataExport: ["create", "read"],
  firmMemory: ["create", "update"],
  conflictCheck: ["run", "review"],
} satisfies StellaPermissionMap;

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

/** Every role's grants: the Better Auth organization ones and stella's own. */
export const ROLE_GRANTS = {
  owner: {
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.owner,
    ...managementStellaGrants,
  },
  admin: {
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.admin,
    ...managementStellaGrants,
  },
  member: {
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.member,
    ...memberStellaGrants,
  },
  intern: {
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.intern,
    ...internStellaGrants,
  },
  external: {
    ...BETTER_AUTH_ORGANIZATION_ROLE_GRANTS.external,
    ...externalStellaGrants,
  },
} satisfies Record<OrganizationRoleName, PermissionMap>;

export const isOrganizationRoleName = (
  role: string,
): role is OrganizationRoleName =>
  ORGANIZATION_ROLE_NAMES.some((name) => name === role);

/** Whether `role` grants `action` on `resource`; an unknown role grants none. */
export const roleGrantsAction = (
  role: string,
  resource: string,
  action: string,
): boolean => {
  if (!isOrganizationRoleName(role)) {
    return false;
  }
  // Widened to an index signature by plain assignment, so any resource name
  // can be looked up without a cast.
  const granted: Partial<Record<string, readonly string[]>> = ROLE_GRANTS[role];
  // `Object.hasOwn` first: a resource named after an inherited key
  // (`constructor`) must deny, not read the prototype.
  const allowed = Object.hasOwn(granted, resource)
    ? granted[resource]
    : undefined;
  return allowed?.includes(action) === true;
};

/**
 * Whether `role` grants every action `permissions` asks for. An unknown role
 * grants nothing, so a client that cannot tell the role offers no action the
 * server would refuse.
 */
export const roleAllows = (
  role: string,
  permissions: PermissionInput,
): boolean => {
  if (!isOrganizationRoleName(role)) {
    return false;
  }
  const requested: Partial<Record<string, readonly string[]>> = permissions;
  return Object.entries(requested).every(
    ([resource, actions]) =>
      actions === undefined ||
      actions.every((action) => roleGrantsAction(role, resource, action)),
  );
};
