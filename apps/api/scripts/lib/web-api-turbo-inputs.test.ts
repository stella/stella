import { expect, test } from "bun:test";

import type { CompilerInputStamp } from "./compiler-input-stamp";
import { uncoveredCompilerInputs } from "./web-api-turbo-inputs";

const stamp = (files: readonly string[]): CompilerInputStamp => ({
  context: "fixture",
  contents: Object.fromEntries(files.map((file) => [file, "hash"])),
  installed: {},
  files: { present: [], absent: [] },
  directories: { present: [], absent: [] },
  realpaths: {},
  subdirectories: {},
  listings: [],
});

test("Turbo inputs cover every repository file read by the compiler", () => {
  const root = "/repo";
  const recorded = stamp([
    `${root}/apps/api/src/eden-contract.ts`,
    `${root}/packages/money/src/money.ts`,
    `${root}/node_modules/typescript/lib/lib.esnext.d.ts`,
    "/outside/repo/package.json",
  ]);
  const inputs = [
    "$TURBO_ROOT$/apps/api/src/**",
    "$TURBO_ROOT$/packages/{money,time}/**",
  ];

  expect(uncoveredCompilerInputs(recorded, root, inputs)).toEqual([]);
  expect(uncoveredCompilerInputs(recorded, root, inputs.slice(1))).toEqual([
    "apps/api/src/eden-contract.ts",
  ]);
});
