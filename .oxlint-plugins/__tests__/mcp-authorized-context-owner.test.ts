import { expect, test } from "bun:test";

import { lintRuleAcrossFiles } from "./lint-single-rule.ts";

test("keeps authorized-context construction in the authority owner", async () => {
  expect(
    await lintRuleAcrossFiles("mcp-authorized-context-owner", {
      ".oxlint-plugins/__fixtures__/mcp-authorized-context-owner.fixture.ts":
        await Bun.file(
          ".oxlint-plugins/__fixtures__/mcp-authorized-context-owner.fixture.ts",
        ).text(),
    }),
  ).toEqual({
    ".oxlint-plugins/__fixtures__/mcp-authorized-context-owner.fixture.ts": [
      1, 3,
    ],
  });
});

test("refuses the authorized-context test helper in production modules", async () => {
  expect(
    await lintRuleAcrossFiles("mcp-authorized-context-owner", {
      "apps/api/src/mcp/production.fixture.ts":
        'import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";\n\nvoid authorizedMcpContextForTest;\n',
    }),
  ).toEqual({ "apps/api/src/mcp/production.fixture.ts": [1] });
});
