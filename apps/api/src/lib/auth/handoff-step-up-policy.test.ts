import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { MCP_HANDOFF_STEP_UP_REQUIRED } from "@stll/api-contract/mcp-web-handoff";

import { getSafeHandlerAccessMetadata } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import {
  createHandoffStepUpGuard,
  HANDOFF_ACCESS_DETAIL,
  isHandoffStepUpGuard,
  requiresHandoffStepUpForAuthPath,
  requiresHandoffStepUpForRequest,
} from "@/api/lib/auth/handoff-step-up-policy";
import api from "@/api/server";

const request = (method: string, path: string) =>
  new Request(`https://example.test${path}`, { method });

const SENSITIVE_PERMISSION_RESOURCES: ReadonlySet<string> = new Set([
  "organizationSettings",
  "member",
  "apiKey",
  "integration",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasSensitivePermissions = (permissions: unknown) => {
  if (!isRecord(permissions)) {
    return false;
  }
  return Object.entries(permissions).some(
    ([resource, actions]) =>
      SENSITIVE_PERMISSION_RESOURCES.has(resource) &&
      Array.isArray(actions) &&
      actions.length > 0,
  );
};

const isHandoffStepUpRefusal = (value: unknown) =>
  isRecord(value) &&
  value["code"] === 403 &&
  isRecord(value["response"]) &&
  value["response"]["code"] === MCP_HANDOFF_STEP_UP_REQUIRED;

const routeRequiresStepUp = (route: (typeof api.routes)[number]) => {
  const metadata = getSafeHandlerAccessMetadata(route.handler);
  const detail = route.hooks.detail;
  let detailAccountAccess: unknown;
  let detailPermissions: unknown;
  if (typeof detail === "object" && detail !== null) {
    if (HANDOFF_ACCESS_DETAIL.accountAccess in detail) {
      detailAccountAccess = detail[HANDOFF_ACCESS_DETAIL.accountAccess];
    }
    if (HANDOFF_ACCESS_DETAIL.permissions in detail) {
      detailPermissions = detail[HANDOFF_ACCESS_DETAIL.permissions];
    }
  }

  return (
    metadata?.accountAccess === ACCOUNT_ACCESS.accountControl ||
    detailAccountAccess === ACCOUNT_ACCESS.accountControl ||
    hasSensitivePermissions(metadata?.permissions) ||
    hasSensitivePermissions(detailPermissions)
  );
};

const registeredHandoffGuards = (route: (typeof api.routes)[number]) => {
  const hooks = route.hooks.beforeHandle;
  let candidates: unknown[];
  if (Array.isArray(hooks)) {
    candidates = hooks;
  } else if (hooks === undefined) {
    candidates = [];
  } else {
    candidates = [hooks];
  }
  return candidates
    .flatMap((hook) => {
      if (typeof hook === "function") {
        return [hook];
      }
      if (
        typeof hook === "object" &&
        hook !== null &&
        "fn" in hook &&
        typeof hook.fn === "function"
      ) {
        return [hook.fn];
      }
      return [];
    })
    .filter(isHandoffStepUpGuard);
};

const missingHandoffStepUpCoverage = (
  routes: readonly (typeof api.routes)[number][],
) =>
  routes.flatMap((route) => {
    if (!routeRequiresStepUp(route)) {
      return [];
    }
    const guarded = registeredHandoffGuards(route).some((guard) => {
      const denied = guard({ handoffOriginConsentId: "consent-id" });
      const allowed = guard({ handoffOriginConsentId: null });
      return isHandoffStepUpRefusal(denied) && allowed === undefined;
    });
    return guarded ? [] : [`${route.method} ${route.path}`];
  });

describe("handoff sessions require recent account authentication", () => {
  test("sensitive guards require resolved session provenance", () => {
    const guard = createHandoffStepUpGuard({
      accountAccess: ACCOUNT_ACCESS.accountControl,
    });
    for (const context of [
      {},
      { handoffOriginConsentId: undefined },
      { handoffOriginConsentId: 1 },
    ]) {
      expect(() => guard(context)).toThrow(
        "Handoff guard requires resolved session provenance",
      );
    }
    expect(guard({ handoffOriginConsentId: null })).toBeUndefined();
    expect(
      isHandoffStepUpRefusal(guard({ handoffOriginConsentId: "consent-id" })),
    ).toBe(true);
  });
  test("every mounted handler with sensitive access metadata has a live guard", () => {
    const sensitive = api.routes.filter(routeRequiresStepUp);
    expect(sensitive.length).toBeGreaterThan(20);
    expect(missingHandoffStepUpCoverage(api.routes)).toEqual([]);
  });

  test("the census detects a sensitive route without a registered refusal", () => {
    const sensitiveRoute = api.routes.find(routeRequiresStepUp);
    expect(sensitiveRoute).toBeDefined();
    if (sensitiveRoute === undefined) {
      return;
    }
    const unguardedRoute = {
      ...sensitiveRoute,
      hooks: { ...sensitiveRoute.hooks, beforeHandle: [] },
    };

    expect(missingHandoffStepUpCoverage([unguardedRoute])).toEqual([
      `${sensitiveRoute.method} ${sensitiveRoute.path}`,
    ]);
  });

  test("raw route detail retains account-control sensitivity beside ordinary permissions", () => {
    const detail = {
      description: "Account-control fixture",
      [HANDOFF_ACCESS_DETAIL.accountAccess]: ACCOUNT_ACCESS.accountControl,
      [HANDOFF_ACCESS_DETAIL.permissions]: { workspace: ["read"] },
    };
    const rawRoute = new Elysia()
      .get("/raw-account-control", () => "ok", {
        detail,
      })
      .routes.at(0);
    expect(rawRoute).toBeDefined();
    if (rawRoute === undefined) {
      return;
    }

    expect(getSafeHandlerAccessMetadata(rawRoute.handler)).toBeUndefined();
    expect(routeRequiresStepUp(rawRoute)).toBe(true);
    expect(missingHandoffStepUpCoverage([rawRoute])).toEqual([
      "GET /raw-account-control",
    ]);
  });

  test("sensitive export routes require step-up", () => {
    for (const path of [
      "/api/exports",
      "/api/export/document",
      "/api/style-sets/style-id/download",
      "/api/entities/zip",
      "/api/invoices/invoice-id/pdf",
    ]) {
      expect(requiresHandoffStepUpForRequest(request("GET", path))).toBe(true);
    }
  });

  test("ordinary data changes and account authentication remain available", () => {
    expect(
      requiresHandoffStepUpForRequest(
        request("DELETE", "/api/contacts/contact"),
      ),
    ).toBe(false);
    expect(
      requiresHandoffStepUpForRequest(request("GET", "/api/v1/files/download")),
    ).toBe(false);
    expect(
      requiresHandoffStepUpForRequest(request("POST", "/api/chat/threads")),
    ).toBe(false);
    for (const path of [
      "/sign-in/email",
      "/sign-in/social",
      "/two-factor/verify-totp",
      "/two-factor/verify-otp",
      "/two-factor/verify-backup-code",
      "/oauth2/token",
    ]) {
      expect(requiresHandoffStepUpForAuthPath(path)).toBe(false);
    }
  });

  test("unclassified auth routes require an explicit decision", () => {
    expect(() =>
      requiresHandoffStepUpForAuthPath("/passkey/verify-authentication"),
    ).toThrow("Auth endpoint has no handoff disposition");
  });
});
