import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw registration payload persistence", async () => {
  expect(
    await lintSingleRule(
      "redact-oauth-registration-response",
      "const row = { registrationResponse: response };",
      { plugin: "mcp-security" },
    ),
  ).toEqual([1]);
});

test("rejects a same-named redactor from an unrelated module", async () => {
  expect(
    await lintSingleRule(
      "redact-oauth-registration-response",
      'import { redactMcpOAuthRegistrationResponse } from "./redactor";\nconst row = { registrationResponse: redactMcpOAuthRegistrationResponse(response) };',
      {
        plugin: "mcp-security",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([2]);
});

test("accepts the canonical redactor through an alias", async () => {
  expect(
    await lintSingleRule(
      "redact-oauth-registration-response",
      'import { redactMcpOAuthRegistrationResponse as redact } from "@/api/lib/mcp-upstream/oauth-registration-response";\nconst row = { registrationResponse: redact(response) };',
      {
        plugin: "mcp-security",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("accepts namespace access to the canonical redactor", async () => {
  expect(
    await lintSingleRule(
      "redact-oauth-registration-response",
      'import * as oauth from "@/api/lib/mcp-upstream/oauth-registration-response";\nconst row = { registrationResponse: oauth.redactMcpOAuthRegistrationResponse(response) };',
      {
        plugin: "mcp-security",
        sourcePath: "apps/api/src/handlers/example.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("accepts reading a persisted field without writing it", async () => {
  expect(
    await lintSingleRule(
      "redact-oauth-registration-response",
      "const { registrationResponse } = row;\nconst other = { response };",
      { plugin: "mcp-security" },
    ),
  ).toEqual([]);
});
