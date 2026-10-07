import { expect, setDefaultTimeout, test } from "bun:test";

import repositoryConfig from "../../oxlint.config.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const source = await Bun.file(
  new URL("../__fixtures__/no-use-before-define.fixture.ts", import.meta.url),
).text();
const configuration = repositoryConfig.rules["eslint/no-use-before-define"];

const lint = async (ruleOptions: unknown) =>
  await lintSingleRule("no-use-before-define", source, {
    builtin: true,
    plugin: "eslint",
    ruleOptions,
  });

test("lexical reads retain same-scope checks while delayed variable reads are allowed", async () => {
  // Oxlint also checks a nested block's read of a later enclosing binding;
  // a function scope can exempt variable reads, while later parameters in
  // default callbacks remain checked.
  expect(await lint(configuration[1])).toEqual([1, 5, 12, 20, 37, 42, 54]);
  expect(configuration).toEqual([
    "error",
    {
      functions: false,
      classes: true,
      variables: false,
      allowNamedExports: false,
    },
  ]);
});

test("enabling variable ordering additionally reports delayed closure references", async () => {
  expect(
    await lint({
      ...configuration[1],
      variables: true,
    }),
  ).toEqual([1, 5, 12, 20, 25, 30, 37, 42, 54]);
});
