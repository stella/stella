import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const SOURCE = [
  'import { asTestRaw } from "@/api/tests/helpers/test-tool-set";',
  'import type { TestToolSet } from "@/api/tests/helpers/test-tool-set";',
  'import { mintAuthProviderId } from "../tests/helpers/auth-provider-id";',
  'const pending = import("@/api/tests/fixture-provenance");',
  'export * from "@/api/tests/setup-env";',
  'import { createSafeId } from "@/api/lib/branded-types";',
  'import { notTests } from "@/api/lib/tests";',
].join("\n");

test("rejects every load of a module under the tests tree, types included", async () => {
  expect(
    await lintSingleRule("no-test-support-import", SOURCE, {
      cwd: "scratch",
      sourcePath: "apps/api/src/lib/planted.ts",
    }),
  ).toEqual([1, 2, 3, 4, 5]);
});
