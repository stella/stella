import { describe, expect, test } from "bun:test";

import {
  classifyPublicKnowledgeWebProbe,
  isMemberOnlySmokeRequest,
} from "../helpers/public-knowledge-smoke.logic";

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

describe("public knowledge root-head marker", () => {
  test("recognizes enabled markers across HTML attribute forms", () => {
    for (const marker of [
      '<meta name="public-knowledge" content="enabled">',
      "<meta content='enabled' name='public-knowledge' />",
      '<META CONTENT = "enabled" NAME = "public-knowledge">',
      "<meta name=public-knowledge content=enabled>",
    ]) {
      expect(
        classifyPublicKnowledgeWebProbe(
          `<html><head>${marker}</head><body></body></html>`,
        ),
      ).toBe("enabled");
    }
  });

  test("absent markers mean disabled, including script and comment lookalikes", () => {
    for (const head of [
      "<title>stella</title>",
      '<meta name="other" content="enabled">',
      `<script>const marker = '<meta name="public-knowledge" content="enabled">'</script>`,
      `<style>body::before { content: '<meta name="public-knowledge" content="enabled">'; }</style>`,
      '<template><meta name="public-knowledge" content="enabled"></template>',
      '<!-- <meta name="public-knowledge" content="enabled"> -->',
    ]) {
      expect(
        classifyPublicKnowledgeWebProbe(
          `<head>${head}</head><body><meta name="public-knowledge" content="enabled"></body>`,
        ),
      ).toBe("disabled");
    }
  });

  test("invalid marker contents fail classification", () => {
    for (const content of [
      'content="disabled"',
      'content="true"',
      'content="ENABLED"',
      'content=""',
      "",
    ]) {
      expect(
        classifyPublicKnowledgeWebProbe(
          `<head><meta name="public-knowledge" ${content}></head>`,
        ),
      ).toBe("unexpected");
    }
  });
});
