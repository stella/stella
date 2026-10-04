import { panic } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  mcpMemberAuthority,
  type McpEffectiveAuthority,
} from "@/api/mcp/effective-authority";

/**
 * The member authority a write tool needs before any of its code runs. It is
 * required on every `access: "write"` definition, so a write tool cannot be
 * registered without stating it, and discovery plus every dispatch path read
 * it through `isMemberAuthorizedForMcpTool` below. Handlers keep their own,
 * input-specific checks as a second layer.
 *
 * - `all`: every call needs this grant, whatever its input.
 * - `any`: the input selects one of several operations (create or update,
 *   delete a document or one of its versions). A caller holding none of the
 *   alternatives can reach no operation, so the tool is withheld; the handler
 *   enforces the exact alternative its input selects. The `reason` names the
 *   input that selects it.
 * - `delegated`: the authority belongs to a target chosen at call time (a
 *   catalog capability, an upstream connector) and is enforced where that
 *   target is resolved. The `reason` names that place.
 */
export type McpWriteToolPermissions =
  | { type: "all"; permissions: PermissionInput }
  | {
      type: "any";
      alternatives: readonly [
        PermissionInput,
        PermissionInput,
        ...PermissionInput[],
      ];
      reason: string;
    }
  | { type: "delegated"; reason: string };

/** The part of a tool definition this owner reads. */
export type McpToolAuthorityDeclaration =
  | { access: "read" }
  | { access: "write"; permissions: McpWriteToolPermissions };

/**
 * Whether a member may be offered and may call this tool. Reads carry no
 * tool-level grant (their scope and per-row checks govern them).
 *
 * Nothing caches the result today (discovery, chat registration and skill
 * availability recompute it per request). A cache of any offered-tool list
 * must key on the role, the credential's permission set and the account
 * access (standard or sandbox), or one member's list serves another.
 */
export const isMemberAuthorizedForMcpTool = (
  authority: AuthorizedMemberRole,
  definition: McpToolAuthorityDeclaration,
): boolean => {
  if (definition.access === "read") {
    return true;
  }
  const { permissions } = definition;
  switch (permissions.type) {
    case "all":
      return hasMemberPermission(authority, permissions.permissions);
    case "any":
      return permissions.alternatives.some((alternative) =>
        hasMemberPermission(authority, alternative),
      );
    case "delegated":
      return true;
    default:
      permissions satisfies never;
      return panic(`Unhandled write tool permissions: ${String(permissions)}`);
  }
};

/** The same decision for an MCP request: its role narrowed by its credential. */
export const hasMcpToolAuthority = (
  authority: McpEffectiveAuthority,
  definition: McpToolAuthorityDeclaration,
): boolean =>
  isMemberAuthorizedForMcpTool(mcpMemberAuthority(authority), definition);

/**
 * Which half of the request's authority refuses the tool: the member role
 * itself, or a credential whose own permission set is narrower than the role.
 * `null` when the tool is authorized. The two need different recoveries (a
 * role change versus a credential that carries the grant).
 */
const mcpToolAuthorityDenial = (
  authority: McpEffectiveAuthority,
  definition: McpToolAuthorityDeclaration,
): "member-role" | "credential" | null => {
  if (hasMcpToolAuthority(authority, definition)) {
    return null;
  }
  return hasMcpToolAuthority({ memberRole: authority.memberRole }, definition)
    ? "credential"
    : "member-role";
};

type McpToolAuthorityRefusalOptions = {
  authority: McpEffectiveAuthority;
  definition: McpToolAuthorityDeclaration;
  toolName: string;
};

type McpToolAuthorityRefusal = {
  code: "permission_denied";
  message: string;
  hint: string;
};

/**
 * The refusal for a tool the request's authority does not cover, or `null`
 * when it is authorized. The HTTP transport answers it before action
 * admission, so an unauthorized call never spends the caller's action budget;
 * dispatch answers it again for callers that enter there directly.
 */
export const mcpToolAuthorityRefusal = ({
  authority,
  definition,
  toolName,
}: McpToolAuthorityRefusalOptions): McpToolAuthorityRefusal | null => {
  const denial = mcpToolAuthorityDenial(authority, definition);
  switch (denial) {
    case null:
      return null;
    case "member-role":
      return {
        code: "permission_denied",
        message: `Your member role does not permit ${toolName}`,
        hint: "Call tools/list for the tools your role offers, or ask an organization administrator for a role that includes this tool.",
      };
    case "credential":
      return {
        code: "permission_denied",
        message: `This credential's permissions do not include ${toolName}`,
        hint: "Your member role allows this tool. Call it with a credential whose permissions include its grant, such as an API key minted with that permission.",
      };
    default:
      denial satisfies never;
      return panic(`Unhandled MCP tool authority denial: ${String(denial)}`);
  }
};
