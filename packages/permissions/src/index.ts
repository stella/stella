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
} satisfies StellaPermissionMap;

const internStellaGrants = {
  ...externalStellaGrants,
  template: ["use"],
  styleSet: ["use"],
  timeEntry: ["read", "create", "update"],
  expense: ["create", "update"],
  chat: ["create", "update", "delete"],
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
