import { expect, test } from "bun:test";

import { lintRuleAcrossFiles, lintSingleRule } from "./lint-single-rule.ts";

test("keeps authorized-context construction in the authority owner", async () => {
  expect(
    await lintSingleRule(
      "mcp-authorized-context-owner",
      [
        'import { authorizedMcpContextForTest } from "@/api/mcp/write-tool-authority";',
        "",
        'const authorizedMcpRequestContextBrand = Symbol("context");',
        "void authorizedMcpContextForTest;",
        "void authorizedMcpRequestContextBrand;",
      ].join("\n"),
      {
        sourcePath:
          ".oxlint-plugins/__fixtures__/mcp-authorized-context-owner.fixture.ts",
        cwd: "scratch",
      },
    ),
  ).toEqual([1, 3]);
});

test("refuses the authorized-context test helper in production modules", async () => {
  expect(
    await lintRuleAcrossFiles("mcp-authorized-context-owner", {
      "apps/api/src/mcp/production.fixture.ts":
        'import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";\n\nvoid authorizedMcpContextForTest;\n',
    }),
  ).toEqual({ "apps/api/src/mcp/production.fixture.ts": [1] });
});

test("keeps authority construction confined across module import forms", async () => {
  const denied = {
    "apps/api/src/mcp/helper-namespace.fixture.ts":
      'import * as helpers from "@/api/tests/helpers/authorized-mcp-context"; helpers.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/helper-relative.fixture.ts":
      'import * as helpers from "../tests/helpers/authorized-mcp-context.ts"; helpers.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/authority-namespace.fixture.ts":
      'import * as authority from "@/api/mcp/write-tool-authority.ts"; authority.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/authority-relative.fixture.ts":
      'import { authorizedMcpContextForTest as grant } from "./write-tool-authority"; grant({});',
    "apps/api/src/mcp/helper-reexport.fixture.ts":
      'export { authorizedMcpContextForTest as grant } from "@/api/tests/helpers/authorized-mcp-context";',
    "apps/api/src/mcp/authority-reexport.fixture.ts":
      'export { authorizedMcpContextForTest as grant } from "./write-tool-authority.ts";',
    "apps/api/src/mcp/helper-star.fixture.ts":
      'export * from "../tests/helpers/authorized-mcp-context";',
    "apps/api/src/mcp/authority-star.fixture.ts":
      'export * from "./write-tool-authority";',
    "apps/api/src/mcp/helper-dynamic.fixture.ts":
      'const helpers = await import("../tests/helpers/authorized-mcp-context"); helpers.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/authority-dynamic.fixture.ts":
      'const authority = await import("./write-tool-authority"); authority.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/helper-require.fixture.ts":
      'const helpers = require("@/api/tests/helpers/authorized-mcp-context"); helpers.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/authority-require.fixture.ts":
      'const authority = require("./write-tool-authority"); authority.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/authority-template-import.fixture.ts":
      "const authority = await import(`./write-tool-authority`); authority.authorizedMcpContextForTest({});",
    "apps/api/src/mcp/authority-template-require.fixture.ts":
      "const authority = require(`./write-tool-authority`); authority.authorizedMcpContextForTest({});",
    "apps/api/src/mcp/authority-alias-dot.fixture.ts":
      'import { authorizedMcpContextForTest as grant } from "@/api/mcp/./write-tool-authority"; grant({});',
    "apps/api/src/mcp/helper-alias-parent.fixture.ts":
      'import * as helpers from "@/api/mcp/../tests/helpers/authorized-mcp-context"; helpers.authorizedMcpContextForTest({});',
    "apps/api/src/mcp/helper-repeated-slash.fixture.ts":
      'import * as helpers from "..//tests/helpers/authorized-mcp-context"; helpers.authorizedMcpContextForTest({});',
  };
  const allowed = {
    "apps/api/src/mcp/public-authority.fixture.ts":
      'import { authorizeMcpToolContext } from "./write-tool-authority"; void authorizeMcpToolContext;',
    "apps/api/src/mcp/helper-namespace.test.ts":
      'import * as helpers from "../tests/helpers/authorized-mcp-context"; helpers.authorizedMcpContextForTest({});',
    "apps/api/src/tests/helpers/authorized-mcp-context.ts":
      'export { authorizedMcpContextForTest } from "@/api/mcp/write-tool-authority";',
    "apps/api/src/mcp/write-tool-authority.ts":
      'const authorizedMcpRequestContextBrand = Symbol("authorized"); void authorizedMcpRequestContextBrand;',
  };
  expect(
    await lintRuleAcrossFiles("mcp-authorized-context-owner", {
      ...denied,
      ...allowed,
    }),
  ).toEqual(
    Object.fromEntries([
      ...Object.keys(denied).map((file) => [file, [1]]),
      ...Object.keys(allowed).map((file) => [file, []]),
    ]),
  );
});
