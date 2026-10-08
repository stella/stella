import { panic } from "better-result";

import { statements } from "@stll/permissions";

import {
  PERSONAL_API_KEY_DEFAULT_SCOPES,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
import type { PersonalApiKeyScope } from "@/api/lib/machine-api-key-config";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

// Shared entity writes span document and matter tools. Transport scope checks
// still gate each tool; unrelated resources retain their own consent boundary.
const PERSONAL_WRITE_SCOPES = {
  organization: null,
  member: null,
  invitation: null,
  team: null,
  ac: null,
  workspace: ["stella:matters_write"],
  contact: ["stella:contacts_write"],
  invoice: null,
  template: null,
  styleSet: null,
  clause: ["stella:knowledge_write"],
  entity: ["stella:documents_write", "stella:matters_write"],
  timeEntry: null,
  expense: null,
  view: ["stella:matters_write"],
  property: ["stella:matters_write"],
  playbook: ["stella:knowledge_write"],
  flow: ["stella:matters_write"],
  signal: ["stella:matters_write"],
  billingCode: null,
  rate: null,
  chat: null,
  organizationSettings: null,
  auditLog: null,
  agentSkill: null,
  firmMemory: null,
  caseLawResearch: null,
  legalReaderAnnotation: ["stella:knowledge_write"],
  savedSearch: null,
  searchHistory: ["stella:knowledge_write"],
  integration: null,
} as const satisfies Record<
  keyof typeof statements,
  readonly PersonalApiKeyScope[] | null
>;

const writeScopes = new Map(Object.entries(PERSONAL_WRITE_SCOPES));
// Listing uses read consent; deletion uses knowledge-write consent. Recording
// and browser imports are UI operations, without personal-key authority.
const PERSONAL_SEARCH_HISTORY_ACTION_SCOPES = {
  read: ["stella:read"],
  create: [],
  delete: PERSONAL_WRITE_SCOPES.searchHistory,
} as const satisfies Record<
  (typeof statements)["searchHistory"][number],
  readonly PersonalApiKeyScope[]
>;
const historyActionScopes = new Map(
  Object.entries(PERSONAL_SEARCH_HISTORY_ACTION_SCOPES),
);
const permissionScopeAllows = (
  resource: string,
  action: string,
  scopes: readonly PersonalApiKeyScope[],
) => {
  if (resource === "searchHistory") {
    return (
      historyActionScopes
        .get(action)
        ?.some((scope) => scopes.includes(scope)) ?? false
    );
  }
  return (
    (resource === "workspace" && action === "read") ||
    (writeScopes.get(resource)?.some((scope) => scopes.includes(scope)) ??
      false)
  );
};

export const personalApiKeyPermissionsAllowed = (
  permissions: Record<string, string[]>,
  scopes: readonly PersonalApiKeyScope[],
) =>
  Object.entries(permissions).every(([resource, actions]) =>
    actions.every((action) => permissionScopeAllows(resource, action, scopes)),
  );

/** Build the credential's ceiling from live membership, excluding administrative resources. */
export const personalApiKeyPermissions = (
  memberRole: AuthorizedMemberRole,
  scopes: readonly PersonalApiKeyScope[] = PERSONAL_API_KEY_DEFAULT_SCOPES,
) => {
  const permissions = new Map<string, string[]>();
  for (const [resource, actions] of Object.entries(statements)) {
    for (const action of actions) {
      if (!permissionScopeAllows(resource, action, scopes)) {
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
