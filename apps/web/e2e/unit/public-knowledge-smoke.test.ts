import { describe, expect, test } from "bun:test";

import { isMemberOnlySmokeRequest } from "../helpers/public-knowledge-smoke.logic";

describe("public visitor request access", () => {
  test("allows public knowledge calls on both API mounts", () => {
    for (const pathname of [
      "/api/v1/public/knowledge/template-packs",
      "/v1/public/knowledge/template-packs",
      "/api/v1/public/knowledge/template-packs/general-legal",
      "/v1/public/knowledge/search",
    ]) {
      expect(
        isMemberOnlySmokeRequest({ pathname, method: "GET" }),
        pathname,
      ).toBe(false);
    }
  });

  test("allows only the anonymous session read on both auth mounts", () => {
    for (const pathname of ["/api/auth/get-session", "/auth/get-session"]) {
      expect(
        isMemberOnlySmokeRequest({ pathname, method: "GET" }),
        pathname,
      ).toBe(false);
    }
  });

  test("session discovery permits only the anonymous GET", () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      expect(
        isMemberOnlySmokeRequest({ pathname: "/api/auth/get-session", method }),
      ).toBe(true);
    }
  });

  test("forbids every other auth request regardless of response status", () => {
    for (const pathname of [
      "/api/auth",
      "/auth",
      "/api/auth/list-sessions",
      "/auth/list-sessions",
      "/api/auth/list-accounts",
      "/auth/list-accounts",
      "/api/auth/organization/list",
      "/auth/organization/get-full-organization",
      "/api/auth/organization/set-active",
      "/auth/sign-in/email-otp",
    ]) {
      expect(
        isMemberOnlySmokeRequest({ pathname, method: "GET" }),
        pathname,
      ).toBe(true);
    }
  });

  test("forbids non-public versioned API calls on both mounts", () => {
    for (const pathname of [
      "/api/v1/workspaces",
      "/v1/workspaces",
      "/api/v1/public-other/resource",
    ]) {
      expect(
        isMemberOnlySmokeRequest({ pathname, method: "GET" }),
        pathname,
      ).toBe(true);
    }
  });
});
