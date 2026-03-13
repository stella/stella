import { createAccessControl } from "better-auth/plugins/access";

/**
 * Statement-based permission definitions for Stella.
 *
 * Each key maps to a resource, and its value is an array of
 * allowed actions. Roles are built by selecting a subset of
 * these actions per resource.
 */
export const statements = {
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
  organizationSettings: ["update"],
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
  organizationSettings: [],
});

export const roles = {
  owner: ac.newRole({
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
    organizationSettings: ["update"],
  }),
  admin: ac.newRole({
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
    organizationSettings: ["update"],
  }),
  member: memberAc,
  intern: ac.newRole({
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
    organizationSettings: [],
  }),
  external: ac.newRole({
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
    organizationSettings: [],
  }),
};
