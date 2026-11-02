import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string, sourcePath: string) =>
  await lintSingleRule("no-fetch-response-body-replacement", source, {
    sourcePath,
  });

test("rejects response and stream construction in the fetch transport", async () => {
  expect(
    await lint(
      ["const body = new ReadableStream();", "return new Response(body);"].join(
        "\n",
      ),
      "packages/fetch/src/index.ts",
    ),
  ).toEqual([1, 2]);
});

test("allows transport responses and test fixtures to use native constructors", async () => {
  expect(await lint("return response;", "packages/fetch/src/index.ts")).toEqual(
    [],
  );
  expect(
    await lint(
      "return new Response(new ReadableStream());",
      "packages/fetch/src/index.test.ts",
    ),
  ).toEqual([]);
});
