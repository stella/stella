import { describe, expect, test } from "bun:test";

import { MCP_HANDOFF_STEP_UP_REQUIRED } from "@stll/api-contract/mcp-web-handoff";

import { apiRoutes } from "@/api/api-routes";
import { unwrapStatus } from "@/api/http/status";
import { getSafeHandlerAccessMetadata } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import {
  handoffStepUpRefusal,
  requiresHandoffStepUpForAuthPath,
  requiresHandoffStepUpForMetadata,
  requiresHandoffStepUpForRequest,
} from "@/api/lib/auth/handoff-step-up-policy";

const request = (method: string, path: string) =>
  new Request(`https://example.test${path}`, { method });

const refusalCode = (answer: unknown) => {
  const { code, value } = unwrapStatus(answer);
  return typeof value === "object" && value !== null && "code" in value
    ? { status: code, code: value.code }
    : undefined;
};

describe("handoff sessions require recent account authentication", () => {
  test("a session opened from a web link is refused where the route's access is sensitive", () => {
    const sensitive = [
      { accountAccess: ACCOUNT_ACCESS.accountControl },
      { permissions: { organizationSettings: ["update"] } },
      { permissions: { member: ["create"] } },
      { permissions: { apiKey: ["create"] } },
      { permissions: { integration: ["create"] } },
      // Account control stays sensitive beside ordinary permissions.
      {
        accountAccess: ACCOUNT_ACCESS.accountControl,
        permissions: { workspace: ["read"] },
      },
    ];
    for (const access of sensitive) {
      const ordinaryPath = request("POST", "/api/contacts");
      expect(
        refusalCode(
          handoffStepUpRefusal({
            originConsentId: "consent-id",
            request: ordinaryPath,
            access,
          }),
        ),
      ).toEqual({ status: 403, code: MCP_HANDOFF_STEP_UP_REQUIRED });
      // An ordinary session keeps every route.
      expect(
        handoffStepUpRefusal({
          originConsentId: null,
          request: ordinaryPath,
          access,
        }),
      ).toBeUndefined();
    }
    for (const access of [
      {},
      { accountAccess: ACCOUNT_ACCESS.standard },
      { permissions: { workspace: ["read"], entity: ["update"] } },
      { permissions: { member: [] } },
    ]) {
      expect(
        handoffStepUpRefusal({
          originConsentId: "consent-id",
          request: request("POST", "/api/contacts"),
          access,
        }),
      ).toBeUndefined();
    }
  });

  test("a sensitive path is refused whatever the route declares", () => {
    expect(
      refusalCode(
        handoffStepUpRefusal({
          originConsentId: "consent-id",
          request: request("GET", "/api/exports"),
          access: {},
        }),
      ),
    ).toEqual({ status: 403, code: MCP_HANDOFF_STEP_UP_REQUIRED });
  });

  test("the served table carries sensitive access metadata on its safe handlers", () => {
    const sensitive = apiRoutes.filter(({ definition }) => {
      const metadata =
        "handler" in definition
          ? getSafeHandlerAccessMetadata(definition.handler)
          : undefined;
      return (
        metadata !== undefined && requiresHandoffStepUpForMetadata(metadata)
      );
    });
    expect(sensitive.length).toBeGreaterThan(20);
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
