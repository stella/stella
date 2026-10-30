import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "require-oauth-grant-admission";
describe.serial(RULE, () => {
  test.each([
    'import { oauthProviderResourceClient as raw } from "@better-auth/oauth-provider/resource-client"; raw();',
    'import * as raw from "@better-auth/oauth-provider/resource-client"; raw.oauthProviderResourceClient();',
    'const raw = await import("@better-auth/oauth-provider/resource-client"); raw.oauthProviderResourceClient();',
    'export * from "@better-auth/oauth-provider/resource-client";',
    'import { jwtVerify as verify } from "jose"; verify(token, key);',
    'import * as jose from "jose"; jose.jwtVerify(token, key);',
  ])("requires the admission owner: %s", async (source) => {
    expect(await lintSingleRule(RULE, source)).toEqual([1]);
  });
  test("accepts verification within the admission owner", async () => {
    expect(
      await lintSingleRule(
        RULE,
        'import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";',
        { sourcePath: "apps/api/src/lib/auth/oauth-grant-admission.ts" },
      ),
    ).toEqual([]);
  });
  test("preserves identity assertion verification at its existing owner", async () => {
    expect(
      await lintSingleRule(
        RULE,
        'import { jwtVerify } from "jose"; jwtVerify(assertion, key);',
        { sourcePath: "apps/api/src/agent-auth/id-jag.ts" },
      ),
    ).toEqual([]);
  });
  test("accepts the admitted verifier at resource boundaries", async () => {
    expect(
      await lintSingleRule(
        RULE,
        'import { verifyOAuthToken } from "@/api/lib/auth/oauth-grant-admission"; verifyOAuthToken(token, options);',
      ),
    ).toEqual([]);
  });
});
