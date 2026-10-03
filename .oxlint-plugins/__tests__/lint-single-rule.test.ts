import { expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

test("parser failures cannot supply clean rule coverage", async () => {
  await expect(
    lintSingleRule("no-unsafe-inner-html", "const broken = ;", {
      sourcePath: "source.tsx",
    }),
  ).rejects.toThrow("oxlint reported a parser or configuration error");
});
