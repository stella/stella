import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("require-static-timeout-label", source, {
    sourcePath: "source.ts",
  });

const call = (label: string) =>
  `await withTimeout(async () => await work(), { label: ${label}, timeoutMs: 10 });`;

test("rejects labels built at runtime", async () => {
  const interpolated = ["`job-$", "{id}`"].join("");
  expect(await lint(`const id = read();\n${call(interpolated)}`)).toEqual([2]);
  expect(await lint(`const id = read();\n${call("id")}`)).toEqual([2]);
  expect(await lint(`let label = "job";\n${call("label")}`)).toEqual([2]);
  expect(
    await lint(
      `const run = async () => {\n  const label = "job";\n  ${call("label")}\n};`,
    ),
  ).toEqual([3]);
});

test("allows literals, module constants and closed label tables", async () => {
  expect(await lint(call('"job-read"'))).toEqual([]);
  expect(await lint(`const LABEL = "job-read";\n${call("LABEL")}`)).toEqual([]);
  expect(
    await lint(
      `const LABELS = { read: "job-read" } as const;\nconst key: keyof typeof LABELS = "read";\n${call("LABELS[key]")}`,
    ),
  ).toEqual([]);
});

test("checks only timeout-named calls", async () => {
  expect(
    await lint(`const id = read();\nawait other({ label: \`job-\${id}\` });`),
  ).toEqual([]);
});
