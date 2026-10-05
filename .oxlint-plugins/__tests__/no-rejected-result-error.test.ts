import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-rejected-result-error", [...lines, ""].join("\n"), {
    plugin: "result-boundary",
  });

describe.serial("result-boundary/no-rejected-result-error", () => {
  test("reports a rejection built from a Result's error", async () => {
    expect(
      await lint([
        "declare const result: { error: Error };",
        "declare const maybe: { error: Error } | undefined;",
        "export const direct = async () => await Promise.reject(result.error);",
        "export const chained = () => Promise.reject(maybe?.error);",
        'export const keyed = () => Promise.reject(result["error"]);',
      ]),
    ).toEqual([3, 4, 5]);
  });

  test("accepts the unwrap helper and rejections built another way", async () => {
    expect(
      await lint([
        "declare const result: { error: Error; cause: Error };",
        "declare const readQueryResult: (value: unknown) => unknown;",
        "declare const toClientError: (error: Error) => Error;",
        "declare const Other: { reject: (error: Error) => void };",
        "export const unwrapped = () => readQueryResult(result);",
        "export const mapped = () => Promise.reject(toClientError(result.error));",
        "export const other = () => Promise.reject(result.cause);",
        "export const fresh = () => Promise.reject(new Error('failed'));",
        "export const notPromise = () => Other.reject(result.error);",
      ]),
    ).toEqual([]);
  });
});
