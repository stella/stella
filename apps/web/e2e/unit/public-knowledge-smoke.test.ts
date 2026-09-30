import { describe, expect, test } from "bun:test";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
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

describe("public knowledge served HTML probe", () => {
  const shell = `<body><!--$--><div class="flex w-full items-center justify-center h-dvh"><span aria-busy="true" data-slot="loader" role="status"><svg><path d="M0 0"></path></svg></span></div><!--/$--><script data-tsr-stream-part="">$_TSR.router={matches:[{i:"__root__",s:"success",ssr:!1}]}</script></body>`;

  test("recognizes the flag-off 200 client loading shell", () => {
    expect(classifyPublicKnowledgeWebProbe(shell)).toBe("disabled");
  });

  test("recognizes the existing contribute heading rendered on the server", () => {
    expect(
      classifyPublicKnowledgeWebProbe(
        `<body><main><h1 class="text-lg font-semibold">${messages.publicTools.contribute.title}</h1><form></form></main></body>`,
      ),
    ).toBe("enabled");
  });

  test("rejects unexpected HTML rather than treating it as flag-off", () => {
    for (const html of [
      "",
      "<body>Forbidden</body>",
      "<body><h1>Sign in</h1></body>",
      `<body><script>const heading = '<h1>${messages.publicTools.contribute.title}</h1>'</script></body>`,
      shell.replace("ssr:!1", "ssr:!0"),
      shell.replace("</div>", "</div><p>Failed to load</p>"),
    ]) {
      expect(classifyPublicKnowledgeWebProbe(html)).toBe("unexpected");
    }
  });
});
