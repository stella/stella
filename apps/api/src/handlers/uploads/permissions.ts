import { Result } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import type { PendingUploadPurposeData } from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type { McpOAuthScope } from "@/api/mcp/constants";

export const uploadRoutePermission = {
  workspace: ["read"],
} satisfies PermissionInput;

export type UploadPurpose = PendingUploadPurposeData["type"];

/**
 * The permission each purpose actually spends. Total over the purpose union, so
 * a new purpose cannot be added without deciding what it costs: a fallback
 * branch would silently hand the new purpose whatever the last one required.
 */
export const UPLOAD_PURPOSE_PERMISSION = {
  entity_create: { entity: ["create"] },
  entity_version: { entity: ["update"] },
  agent_skill: { agentSkill: ["create"] },
} as const satisfies Record<UploadPurpose, PermissionInput>;

/**
 * The consent an upload purpose spends.
 *
 * `uploads.*` takes one domain scope in the capability catalog, but its
 * purposes do not finalize into the same resource: `agent_skill` installs a
 * skill, which is what `stella:skills` is the consent for, while the document
 * purposes create a document or a document version, the consent the named
 * document tools spend (`WRITE_PRIMITIVE_SCOPES`). Without this the domain
 * scope would let a matters-write consent install a skill or write a document.
 * MCP checks it before dispatch (`mcp/upload-purpose-gate.ts`); an app's
 * access token on REST is checked in the handler (`authorizeUploadConsent`).
 *
 * Total over the purpose union, so a new purpose cannot be added without
 * deciding which consent covers it.
 */
export const UPLOAD_PURPOSE_SCOPE = {
  entity_create: "stella:documents_write",
  entity_version: "stella:documents_write",
  agent_skill: "stella:skills",
} as const satisfies Record<UploadPurpose, McpOAuthScope>;

type AuthorizeUploadPurposeProps = {
  memberRole: AuthorizedMemberRole;
  purpose: UploadPurpose;
};

export const authorizeUploadPurpose = ({
  memberRole,
  purpose,
}: AuthorizeUploadPurposeProps): Result<void, HandlerError> => {
  if (hasMemberPermission(memberRole, UPLOAD_PURPOSE_PERMISSION[purpose])) {
    return Result.ok(undefined);
  }
  return Result.err(new HandlerError({ status: 403, message: "Forbidden" }));
};

type AuthorizeUploadConsentProps = {
  /** The scopes of an app's access token; absent for a browser session. */
  grantedScopes: readonly string[] | undefined;
  purpose: UploadPurpose;
};

/**
 * Whether the credential consented to what this upload produces. A token's
 * route admission proves only the upload domain's scope, so the purpose's own
 * scope is checked here, the same pairing MCP applies: a document needs
 * `stella:documents_write`, and a skill needs `stella:skills`, which no API
 * token carries. A browser session is the person acting directly, with no
 * scopes to spend. Abandoning an upload produces nothing and needs no more
 * than the domain scope, as on MCP.
 */
export const authorizeUploadConsent = ({
  grantedScopes,
  purpose,
}: AuthorizeUploadConsentProps): Result<void, HandlerError> => {
  const required = UPLOAD_PURPOSE_SCOPE[purpose];
  if (grantedScopes === undefined || grantedScopes.includes(required)) {
    return Result.ok(undefined);
  }
  return Result.err(
    new HandlerError({
      status: 403,
      message: `This upload needs the ${required} scope`,
    }),
  );
};
