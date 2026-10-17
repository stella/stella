import { panic } from "better-result";
import { status } from "elysia";

import { MCP_HANDOFF_STEP_UP_REQUIRED } from "@stll/api-contract/mcp-web-handoff";

import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import type { AccountAccess } from "@/api/lib/auth/account-access";
import { HANDOFF_AUTH_ENDPOINT_POLICY } from "@/api/lib/auth/handoff-auth-endpoint-policy";
import { matchesAuthPathTemplate } from "@/api/lib/auth/review-account-token-subjects";

export const HANDOFF_ACCESS_DETAIL = {
  accountAccess: "__stellaHandoffAccountAccess",
  permissions: "__stellaHandoffPermissions",
} as const;

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

type HandoffAccessMetadata = {
  accountAccess?: AccountAccess;
  permissions?: Readonly<Record<string, readonly string[] | undefined>>;
};
const requiresHandoffStepUpForMetadata = ({
  accountAccess,
  permissions,
}: HandoffAccessMetadata) =>
  accountAccess === ACCOUNT_ACCESS.accountControl ||
  (permissions?.["organizationSettings"]?.length ?? 0) > 0 ||
  (permissions?.["member"]?.length ?? 0) > 0 ||
  (permissions?.["apiKey"]?.length ?? 0) > 0 ||
  (permissions?.["integration"]?.length ?? 0) > 0;

const registeredGuards = new WeakSet<object>();
export const createHandoffStepUpGuard = (metadata: HandoffAccessMetadata) => {
  const required = requiresHandoffStepUpForMetadata(metadata);
  const guard = (context: unknown) => {
    if (!required) {
      return undefined;
    }
    // Macro dependencies resolve at runtime before their beforeHandle hooks.
    if (
      typeof context !== "object" ||
      context === null ||
      !("handoffOriginConsentId" in context) ||
      (context.handoffOriginConsentId !== null &&
        typeof context.handoffOriginConsentId !== "string")
    ) {
      return panic("Handoff guard requires resolved session provenance");
    }
    return context.handoffOriginConsentId
      ? status(403, {
          code: MCP_HANDOFF_STEP_UP_REQUIRED,
          message: "Sign in again to continue.",
        })
      : undefined;
  };
  registeredGuards.add(guard);
  return guard;
};

type HandoffStepUpGuard = ReturnType<typeof createHandoffStepUpGuard>;

export const isHandoffStepUpGuard = (
  value: unknown,
): value is HandoffStepUpGuard =>
  typeof value === "function" && registeredGuards.has(value);

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
