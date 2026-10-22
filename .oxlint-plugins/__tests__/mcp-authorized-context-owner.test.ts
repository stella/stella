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
