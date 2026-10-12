import { status } from "elysia";

import { MCP_HANDOFF_STEP_UP_REQUIRED } from "@stll/api-contract/mcp-web-handoff";

import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import type { AccountAccess } from "@/api/lib/auth/account-access";

export const HANDOFF_ACCESS_DETAIL = {
  accountAccess: "__stellaHandoffAccountAccess",
  permissions: "__stellaHandoffPermissions",
} as const;

const isPathFamily = (path: string, family: string) =>
  path === family || path.startsWith(`${family}/`);

const normalizePath = (path: string) =>
  path
    .replace(/^\/api(?=\/|$)/u, "")
    .replace(/^\/v1(?=\/|$)/u, "")
    .replace(/\/+$/u, "") || "/";

export const requiresHandoffStepUpForRequest = (request: Request): boolean => {
  const path = normalizePath(new URL(request.url).pathname);
  return (
    /(?:^|[/-])exports?(?:[/-]|$)/u.test(path) ||
    /^\/style-sets\/[^/]+\/download$/u.test(path) ||
    /^\/entities\/zip(?:\/|$)/u.test(path) ||
    /^\/invoices\/[^/]+\/pdf$/u.test(path)
  );
};

type HandoffAccessMetadata = {
  accountAccess?: AccountAccess;
  permissions?: Readonly<Record<string, readonly string[] | undefined>>;
};
export const requiresHandoffStepUpForMetadata = ({
  accountAccess,
  permissions,
}: HandoffAccessMetadata) =>
  accountAccess === ACCOUNT_ACCESS.accountControl ||
  (permissions?.organizationSettings?.length ?? 0) > 0 ||
  (permissions?.member?.length ?? 0) > 0 ||
  (permissions?.apiKey?.length ?? 0) > 0 ||
  (permissions?.integration?.length ?? 0) > 0;

const registeredGuards = new WeakSet<object>();
export const createHandoffStepUpGuard = (metadata: HandoffAccessMetadata) => {
  const required = requiresHandoffStepUpForMetadata(metadata);
  const guard = ({
    handoffOriginConsentId,
  }: {
    handoffOriginConsentId: string | null;
  }) =>
    required && handoffOriginConsentId
      ? status(403, {
          code: MCP_HANDOFF_STEP_UP_REQUIRED,
          message: "Sign in again to continue.",
        })
      : undefined;
  registeredGuards.add(guard);
  return guard;
};

export type HandoffStepUpGuard = (context: {
  handoffOriginConsentId: string | null;
}) => unknown;

export const isHandoffStepUpGuard = (
  value: unknown,
): value is HandoffStepUpGuard =>
  typeof value === "function" && registeredGuards.has(value);

export const requiresHandoffStepUpForAuthPath = (path: string): boolean => {
  const normalized = normalizePath(path).replace(/^\/auth(?=\/|$)/u, "");
  if (
    [
      "/passkey/generate-authenticate-options",
      "/passkey/verify-authentication",
      "/two-factor/send-otp",
      "/two-factor/verify-totp",
      "/two-factor/verify-otp",
      "/two-factor/verify-backup-code",
      "/oauth2/token",
      "/organization/list",
      "/organization/get-full-organization",
      "/organization/get-active-member",
      "/organization/get-active-member-role",
      "/organization/list-members",
      "/organization/list-user-organizations",
      "/organization/list-invitations",
      "/organization/get-invitation",
    ].includes(normalized)
  ) {
    return false;
  }
  if (
    [
      "/organization",
      "/two-factor",
      "/passkey",
      "/api-key",
      "/oauth2",
      "/admin/oauth2",
      "/sso",
      "/scim",
    ].some((family) => isPathFamily(normalized, family))
  ) {
    return true;
  }
  return [
    "/change-password",
    "/set-password",
    "/change-email",
    "/delete-user",
    "/update-user",
    "/link-social",
    "/unlink-account",
    "/revoke-session-by-id",
    "/email-otp/change-email",
    "/email-otp/request-email-change",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
  ].some((family) => isPathFamily(normalized, family));
};
