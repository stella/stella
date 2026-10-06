import { panic, Result } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import type { AccountAccess } from "@/api/lib/api-handlers";
import { checkStandardAccountOperation } from "@/api/lib/auth/review-account";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  mcpMemberAuthority,
  type McpEffectiveAuthority,
} from "@/api/mcp/effective-authority";

/** One operation a write tool's input can select, with the grant it needs. */
export type McpWriteToolOperation = {
  /** A short name for the operation, e.g. `create` or `delete_version`. */
  operation: string;
  permissions: PermissionInput;
};

/**
 * How the input selects the operation. `presence`: whether `property` is set
 * (an id that selects update over create). `value`: the value of an enum
 * `property`; `values` must cover every value the input schema allows.
 */
export type McpWriteToolOperationSelector =
  | {
      by: "presence";
      property: string;
      present: McpWriteToolOperation;
      absent: McpWriteToolOperation;
    }
  | {
      by: "value";
      property: string;
      values: Readonly<Record<string, McpWriteToolOperation>>;
    };

/**
 * The member authority a write tool needs before any of its code runs. It is
 * required on every `access: "write"` definition, so a write tool cannot be
 * registered without stating it, and discovery plus every dispatch path read
 * it through this owner. Handlers keep their own, input-specific checks as a
 * second layer.
 *
 * - `all`: every call needs this grant, whatever its input.
 * - `input`: the input selects one of several operations (create or update,
 *   delete a document or one of its versions), each with its exact grant.
 *   Discovery offers the tool to a member holding any operation's grant;
 *   dispatch checks the grant of the operation the normalized input selects
 *   before the handler runs.
 * - `any`: like `input`, but the operation is not declared, so the central
 *   gate checks only that one alternative is held and the handler enforces
 *   the exact one. Kept only for tools listed in the ledger.
 * - `delegated`: the authority belongs to a target chosen at call time (a
 *   catalog capability, an upstream connector) and is enforced where that
 *   target is resolved. The `reason` names that place.
 */
export type McpWriteToolPermissions =
  | { type: "all"; permissions: PermissionInput }
  | { type: "input"; select: McpWriteToolOperationSelector }
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

/**
 * A `value` selector whose keys are checked against the enum the input
 * schema is built from, so adding an enum value without a grant does not
 * compile.
 */
export const selectOperationByValue = <const TValue extends string>(
  property: string,
  values: Readonly<Record<TValue, McpWriteToolOperation>>,
): McpWriteToolPermissions => ({
  type: "input",
  select: { by: "value", property, values },
});

/** A `presence` selector: `property` set selects `present`, else `absent`. */
export const selectOperationByPresence = (
  property: string,
  {
    present,
    absent,
  }: { present: McpWriteToolOperation; absent: McpWriteToolOperation },
): McpWriteToolPermissions => ({
  type: "input",
  select: { by: "presence", property, present, absent },
});

/** Every operation a selector can choose. */
export const selectableOperations = (
  select: McpWriteToolOperationSelector,
): readonly McpWriteToolOperation[] => {
  switch (select.by) {
    case "presence":
      return [select.present, select.absent];
    case "value":
      return Object.values(select.values);
    default:
      select satisfies never;
      return panic(`Unhandled operation selector: ${String(select)}`);
  }
};

/**
 * The operation a normalized input selects, or `null` when it selects none
 * (an enum value without a declared operation): the caller refuses then.
 */
const selectWriteToolOperation = (
  select: McpWriteToolOperationSelector,
  input: Readonly<Record<string, unknown>>,
): McpWriteToolOperation | null => {
  const value = input[select.property];
  switch (select.by) {
    case "presence":
      return value === undefined || value === null
        ? select.absent
        : select.present;
    case "value":
      return typeof value === "string" && Object.hasOwn(select.values, value)
        ? (select.values[value] ?? null)
        : null;
    default:
      select satisfies never;
      return panic(`Unhandled operation selector: ${String(select)}`);
  }
};

/**
 * The part of a tool definition this owner reads. `accountAccess` matches the
 * REST handler declaration: `standard` refuses the configured demo account,
 * `sandbox` admits it.
 */
export type McpToolAuthorityDeclaration =
  | { access: "read" }
  | {
      access: "write";
      permissions: McpWriteToolPermissions;
      accountAccess: AccountAccess;
    };

/**
 * Whether a member may be offered this tool and reach its dispatch. Reads
 * carry no tool-level grant (their scope and per-row checks govern them). A
 * tool whose input selects its operation is offered when any operation is
 * held; `isMemberAuthorizedForMcpToolInput` decides the call.
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
    case "input":
      return selectableOperations(permissions.select).some((operation) =>
        hasMemberPermission(authority, operation.permissions),
      );
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

/**
 * The call-time decision on the normalized input: the exact grant of the
 * operation it selects. Declarations without a selector decide as discovery
 * does.
 */
export const isMemberAuthorizedForMcpToolInput = (
  authority: AuthorizedMemberRole,
  definition: McpToolAuthorityDeclaration,
  input: Readonly<Record<string, unknown>>,
): boolean => {
  if (definition.access === "read" || definition.permissions.type !== "input") {
    return isMemberAuthorizedForMcpTool(authority, definition);
  }
  const operation = selectWriteToolOperation(
    definition.permissions.select,
    input,
  );
  return (
    operation !== null && hasMemberPermission(authority, operation.permissions)
  );
};

/** The same decision for an MCP request: its role narrowed by its credential. */
export const hasMcpToolAuthority = (
  authority: McpEffectiveAuthority,
  definition: McpToolAuthorityDeclaration,
): boolean =>
  isMemberAuthorizedForMcpTool(mcpMemberAuthority(authority), definition);

/** `isMemberAuthorizedForMcpToolInput` for an MCP request. */
export const hasMcpToolInputAuthority = (
  authority: McpEffectiveAuthority,
  definition: McpToolAuthorityDeclaration,
  input: Readonly<Record<string, unknown>>,
): boolean =>
  isMemberAuthorizedForMcpToolInput(
    mcpMemberAuthority(authority),
    definition,
    input,
  );

export type AccountOperationCheck = typeof checkStandardAccountOperation;

/** The refusal REST answers a `standard` handler with for a restricted account. */
export const ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE =
  "This operation is unavailable for this account.";

/**
 * Whether this account may be offered and call the tool: a `standard` write
 * tool refuses the demo and restricted review accounts, as its REST
 * counterpart does.
 */
export const isAccountAuthorizedForMcpTool = (
  userEmail: string,
  definition: McpToolAuthorityDeclaration,
  checkAccountOperation: AccountOperationCheck = checkStandardAccountOperation,
): boolean =>
  definition.access === "read" ||
  definition.accountAccess === "sandbox" ||
  Result.isOk(checkAccountOperation(userEmail));
type McpToolAuthorityDenial = "member-role" | "credential";

/**
 * Which half of the request's authority refuses the tool: the member role
 * itself, or a credential whose own permission set is narrower than the role.
 * `null` when the tool is authorized. The two need different recoveries (a
 * role change versus a credential that carries the grant).
 */
const mcpToolAuthorityDenial = (
  authority: McpEffectiveAuthority,
  definition: McpToolAuthorityDeclaration,
): McpToolAuthorityDenial | null => {
  if (hasMcpToolAuthority(authority, definition)) {
    return null;
  }
  return hasMcpToolAuthority({ memberRole: authority.memberRole }, definition)
    ? "credential"
    : "member-role";
};

/**
 * `mcpToolAuthorityDenial` for the operation the normalized input selects:
 * whether the member role or a narrower credential refuses its exact grant.
 */
export const mcpToolInputAuthorityDenial = (
  authority: McpEffectiveAuthority,
  definition: McpToolAuthorityDeclaration,
  input: Readonly<Record<string, unknown>>,
): McpToolAuthorityDenial | null => {
  if (hasMcpToolInputAuthority(authority, definition, input)) {
    return null;
  }
  return hasMcpToolInputAuthority(
    { memberRole: authority.memberRole },
    definition,
    input,
  )
    ? "credential"
    : "member-role";
};

type McpToolAuthorityRefusal = {
  code: "permission_denied";
  message: string;
  hint?: string;
};

/**
 * The refusal for `subject` (a tool, or the operation its input selects). A
 * credential narrower than the role needs a different credential, not a role
 * change, so the two are told apart.
 */
export const mcpToolAuthorityDenialRefusal = (
  subject: string,
  denial: McpToolAuthorityDenial,
): McpToolAuthorityRefusal => {
  switch (denial) {
    case "member-role":
      return {
        code: "permission_denied",
        message: `Your member role does not permit ${subject}`,
        hint: "Call tools/list for the tools your role offers, or ask an organization administrator for a role that includes this tool.",
      };
    case "credential":
      return {
        code: "permission_denied",
        message: `This credential's permissions do not include ${subject}`,
        hint: "Your member role allows this tool. Call it with a credential whose permissions include its grant, such as an API key minted with that permission.",
      };
    default:
      denial satisfies never;
      return panic(`Unhandled MCP tool authority denial: ${String(denial)}`);
  }
};

type McpToolAuthorityRefusalOptions = {
  authority: McpEffectiveAuthority;
  definition: McpToolAuthorityDeclaration;
  toolName: string;
  userEmail: string;
};

/**
 * The refusal for a tool the request's authority (member permissions
 * narrowed by the credential, then account access) does not cover, or `null`
 * when it is authorized. The HTTP transport answers it before action
 * admission, so an unauthorized call never spends the caller's action budget;
 * dispatch answers it again for callers that enter there directly.
 */
export const mcpToolAuthorityRefusal = ({
  authority,
  definition,
  toolName,
  userEmail,
}: McpToolAuthorityRefusalOptions): McpToolAuthorityRefusal | null => {
  const denial = mcpToolAuthorityDenial(authority, definition);
  if (denial !== null) {
    return mcpToolAuthorityDenialRefusal(toolName, denial);
  }
  if (!isAccountAuthorizedForMcpTool(userEmail, definition)) {
    return {
      code: "permission_denied",
      message: ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE,
    };
  }
  return null;
};
