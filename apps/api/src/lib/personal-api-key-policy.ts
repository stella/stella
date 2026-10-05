import { panic } from "better-result";

import { statements } from "@stll/permissions";

import {
  PERSONAL_API_KEY_DEFAULT_SCOPES,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
import type { PersonalApiKeyScope } from "@/api/lib/machine-api-key-config";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

const PERSONAL_PERMISSION_POLICY = {
  organization: "deny",
  member: "deny",
  invitation: "deny",
  team: "deny",
  ac: "deny",
  workspace: "allow",
  contact: "allow",
  invoice: "deny",
  template: "allow",
  styleSet: "allow",
  clause: "allow",
  entity: "allow",
  timeEntry: "deny",
  expense: "deny",
  view: "allow",
  property: "allow",
  playbook: "allow",
  flow: "allow",
  signal: "allow",
  billingCode: "deny",
  rate: "deny",
  chat: "allow",
  organizationSettings: "deny",
  auditLog: "deny",
  agentSkill: "allow",
  firmMemory: "deny",
  caseLawResearch: "allow",
  legalReaderAnnotation: "allow",
  savedSearch: "allow",
  integration: "deny",
} as const satisfies Record<keyof typeof statements, "allow" | "deny">;

const permissionPolicy: Record<string, "allow" | "deny" | undefined> =
  PERSONAL_PERMISSION_POLICY;

export const personalApiKeyPermissionsAllowed = (
  permissions: Record<string, string[]>,
) =>
  Object.keys(permissions).every(
    (resource) => permissionPolicy[resource] === "allow",
  );

/** Build the credential's ceiling from live membership, excluding administrative resources. */
export const personalApiKeyPermissions = (
  memberRole: AuthorizedMemberRole,
  scopes: readonly PersonalApiKeyScope[] = PERSONAL_API_KEY_DEFAULT_SCOPES,
) => {
  const writes = scopes.some(
    (scope) => scope !== "stella:search" && scope !== "stella:read",
  );
  const permissions = new Map<string, string[]>();
  for (const [resource, actions] of Object.entries(statements)) {
    if (permissionPolicy[resource] !== "allow") {
      continue;
    }
    for (const action of actions) {
      if (!writes && (resource !== "workspace" || action !== "read")) {
        continue;
      }
      const parsed = parseMachineApiKeyPermissions({ [resource]: [action] });
      if (parsed.type !== "valid") {
        panic("Permission statements must parse through their owning schema");
      }
      if (!hasMemberPermission(memberRole, parsed.permissions)) {
        continue;
      }
      const granted = permissions.get(resource) ?? [];
      granted.push(action);
      permissions.set(resource, granted);
    }
  }
  return Object.fromEntries(permissions);
};
