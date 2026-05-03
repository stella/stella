import { createAccessControl } from "better-auth/plugins/access";

/**
 * Statement-based permission definitions for Stella.
 *
 * Each key maps to a resource, and its value is an array of
 * allowed actions. Roles are built by selecting a subset of
 * these actions per resource.
 */
export const statements = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
  workspace: ["read", "create", "update", "delete"],
  contact: ["create", "update", "delete"],
  invoice: ["create", "update", "delete"],
  template: ["create", "update", "delete"],
  clause: ["create", "update", "delete"],
  entity: ["create", "update", "delete"],
  timeEntry: ["create", "update", "delete"],
  expense: ["create", "update", "delete"],
  view: ["create", "update", "delete"],
  property: ["create", "update", "delete"],
  billingCode: ["create", "update", "delete"],
  rate: ["create", "update", "delete"],
  // todo: add better permissions for chat
  chat: ["create", "delete"],
  organizationSettings: ["update"],
  auditLog: ["read"],
  promptShortcut: ["create", "update", "delete"],
} as const;

type PermissionMap = {
  [K in keyof typeof statements]: (typeof statements)[K][number][];
};

type RequireAtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

export type PermissionInput = RequireAtLeastOne<Partial<PermissionMap>>;

export const ac = createAccessControl(statements);

const memberAc = ac.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ["read"],
  workspace: ["read", "create", "update", "delete"],
  contact: ["create", "update", "delete"],
  invoice: ["create", "update", "delete"],
  template: ["create", "update", "delete"],
  clause: ["create", "update", "delete"],
  entity: ["create", "update", "delete"],
  timeEntry: ["create", "update", "delete"],
  expense: ["create", "update", "delete"],
  view: ["create", "update", "delete"],
  property: ["create", "update", "delete"],
  billingCode: ["create", "update", "delete"],
  rate: ["create", "update", "delete"],
  chat: ["create", "delete"],
  organizationSettings: [],
  auditLog: [],
  promptShortcut: ["create", "update", "delete"],
});

export const roles = {
  owner: ac.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
    workspace: ["read", "create", "update", "delete"],
    contact: ["create", "update", "delete"],
    invoice: ["create", "update", "delete"],
    template: ["create", "update", "delete"],
    clause: ["create", "update", "delete"],
    entity: ["create", "update", "delete"],
    timeEntry: ["create", "update", "delete"],
    expense: ["create", "update", "delete"],
    view: ["create", "update", "delete"],
    property: ["create", "update", "delete"],
    billingCode: ["create", "update", "delete"],
    rate: ["create", "update", "delete"],
    chat: ["create", "delete"],
    organizationSettings: ["update"],
    auditLog: ["read"],
    promptShortcut: ["create", "update", "delete"],
  }),
  admin: ac.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
    workspace: ["read", "create", "update", "delete"],
    contact: ["create", "update", "delete"],
    invoice: ["create", "update", "delete"],
    template: ["create", "update", "delete"],
    clause: ["create", "update", "delete"],
    entity: ["create", "update", "delete"],
    timeEntry: ["create", "update", "delete"],
    expense: ["create", "update", "delete"],
    view: ["create", "update", "delete"],
    property: ["create", "update", "delete"],
    billingCode: ["create", "update", "delete"],
    rate: ["create", "update", "delete"],
    chat: ["create", "delete"],
    organizationSettings: ["update"],
    auditLog: ["read"],
    promptShortcut: ["create", "update", "delete"],
  }),
  member: memberAc,
  intern: ac.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: [],
    workspace: ["read"],
    contact: [],
    invoice: [],
    template: [],
    clause: [],
    entity: [],
    timeEntry: ["create", "update"],
    expense: ["create", "update"],
    view: [],
    property: [],
    billingCode: [],
    rate: [],
    chat: ["create", "delete"],
    organizationSettings: [],
    auditLog: [],
    promptShortcut: [],
  }),
  external: ac.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: [],
    workspace: ["read"],
    contact: [],
    invoice: [],
    template: [],
    clause: [],
    entity: [],
    timeEntry: [],
    expense: [],
    view: [],
    property: [],
    billingCode: [],
    rate: [],
    chat: [],
    organizationSettings: [],
    auditLog: [],
    promptShortcut: [],
  }),
};
