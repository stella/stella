import { describe, expect, test } from "bun:test";

import {
  requiresHandoffStepUpForAuthPath,
  requiresHandoffStepUpForRequest,
} from "@/api/lib/auth/handoff-step-up-policy";
import api from "@/api/server";

const request = (method: string, path: string) =>
  new Request(`https://example.test${path}`, { method });

describe("handoff sessions require recent account authentication", () => {
  test("every mounted sensitive application route is covered", () => {
    const sensitive = api.routes.filter(({ method, path }) => {
      if (
        /(?:^|[/-])exports?(?:[/-]|$)/u.test(path) ||
        /\/style-sets\/[^/]+\/download$/u.test(path) ||
        /\/entities\/zip(?:\/|$)/u.test(path) ||
        /\/invoices\/[^/]+\/pdf$/u.test(path) ||
        /^\/(?:api\/)?v1\/me\/(?:delete|two-factor)(?:\/|$)/u.test(path)
      ) {
        return true;
      }
      return (
        !["GET", "HEAD", "OPTIONS"].includes(method) &&
        (/(?:^|\/)(?:members|roles)(?:\/|$)/u.test(path) ||
          /^\/(?:api\/)?v1\/(?:organization-settings|organizations|members|api-keys|me\/oauth-connections)(?:\/|$)/u.test(
            path,
          ))
      );
    });
    expect(sensitive.length).toBeGreaterThan(20);
    for (const { method, path } of sensitive) {
      expect(requiresHandoffStepUpForRequest(request(method, path))).toBe(true);
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

  test("new endpoints in sensitive authentication families require step-up", () => {
    for (const family of [
      "organization",
      "two-factor",
      "passkey",
      "api-key",
      "oauth2",
    ]) {
      expect(
        requiresHandoffStepUpForAuthPath(`/${family}/future-operation`),
      ).toBe(true);
    }
    for (const path of [
      "/change-password",
      "/set-password",
      "/change-email",
      "/delete-user",
      "/link-social",
      "/unlink-account",
      "/oauth2/authorize",
      "/oauth2/consent",
    ]) {
      expect(requiresHandoffStepUpForAuthPath(path)).toBe(true);
    }
  });
});
