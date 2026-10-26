import { panic } from "better-result";

import { MCP_HANDOFF_STEP_UP_REQUIRED } from "@stll/api-contract/mcp-web-handoff";

import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import type { AccountAccess } from "@/api/lib/auth/account-access";
import { HANDOFF_AUTH_ENDPOINT_POLICY } from "@/api/lib/auth/handoff-auth-endpoint-policy";
import { matchesAuthPathTemplate } from "@/api/lib/auth/review-account-token-subjects";

const normalizePath = (path: string) => {
  const normalized = path
    .replace(/^\/api(?=\/|$)/u, "")
    .replace(/^\/v1(?=\/|$)/u, "");
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "/") {
    end -= 1;
  }
  return normalized.slice(0, end) || "/";
};

export const requiresHandoffStepUpForRequest = (request: Request): boolean => {
  const path = normalizePath(new URL(request.url).pathname);
  return (
    /(?:^|[/-])exports?(?:[/-]|$)/u.test(path) ||
    /^\/style-sets\/[^/]+\/download$/u.test(path) ||
    /^\/entities\/zip(?:\/|$)/u.test(path) ||
    /^\/invoices\/[^/]+\/pdf$/u.test(path)
  );
};

/**
 * What a route declares about its access: the account access its config
 * names and the member permissions it requires. A plumbing endpoint declares
 * neither.
 */
export type HandoffAccessMetadata = {
  readonly accountAccess?: AccountAccess;
  readonly permissions?: Readonly<
    Record<string, readonly string[] | undefined>
  >;
};

/** Account control and member, key, integration or settings permissions. */
export const requiresHandoffStepUpForMetadata = ({
  accountAccess,
  permissions,
}: HandoffAccessMetadata): boolean =>
  accountAccess === ACCOUNT_ACCESS.accountControl ||
  (permissions?.["organizationSettings"]?.length ?? 0) > 0 ||
  (permissions?.["member"]?.length ?? 0) > 0 ||
  (permissions?.["apiKey"]?.length ?? 0) > 0 ||
  (permissions?.["integration"]?.length ?? 0) > 0;

const HANDOFF_STEP_UP_REFUSAL = {
  code: MCP_HANDOFF_STEP_UP_REQUIRED,
  message: "Sign in again to continue.",
} as const;

/**
 * The refusal for a session opened from an MCP web link, on a request that
 * needs the account's own recent sign-in: a sensitive path (an export, a
 * download) or a route whose access is sensitive. Every access step that
 * admits a browser session asks it, with the route's declared access.
 */
export const handoffStepUpRefusal = ({
  originConsentId,
  request,
  access,
}: {
  readonly originConsentId: string | null;
  readonly request: Request;
  readonly access: HandoffAccessMetadata;
}) =>
  originConsentId !== null &&
  (requiresHandoffStepUpForRequest(request) ||
    requiresHandoffStepUpForMetadata(access))
    ? status(403, HANDOFF_STEP_UP_REFUSAL)
    : undefined;

const authDispositionByPath = new Map(
  Object.entries(HANDOFF_AUTH_ENDPOINT_POLICY),
);
const parameterizedAuthDispositions = Object.entries(
  HANDOFF_AUTH_ENDPOINT_POLICY,
).filter(([path]) => path.includes(":"));

export const requiresHandoffStepUpForAuthPath = (path: string): boolean => {
  // Better Call also dispatches server-only helpers, which have no HTTP path.
  if (!path.startsWith("/")) {
    return false;
  }
  const normalized = normalizePath(path).replace(/^\/auth(?=\/|$)/u, "");
  const disposition =
    authDispositionByPath.get(normalized) ??
    parameterizedAuthDispositions.find(([template]) =>
      matchesAuthPathTemplate(template, normalized),
    )?.[1];
  if (disposition === undefined) {
    return panic(`Auth endpoint has no handoff disposition: ${normalized}`);
  }
  switch (disposition) {
    case "refused":
      return true;
    case "step-up-method":
    case "ordinary":
      return false;
    default:
      disposition satisfies never;
      return panic("Unhandled auth endpoint disposition");
  }
};
