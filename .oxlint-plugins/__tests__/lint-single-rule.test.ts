import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  lintSingleRule,
  lintsAlone,
  runSingleRule,
} from "./lint-single-rule.ts";

test("parser failures cannot supply clean rule coverage", async () => {
  const result = await Result.tryPromise(
    async () =>
      await lintSingleRule("no-unsafe-inner-html", "const broken = ;", {
        sourcePath: "source.tsx",
      }),
  );
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toContain(
      "oxlint reported a parser or configuration error",
    );
  }
});

test("fix, scratch and override cases never share an oxlint run", () => {
  expect(lintsAlone({})).toBe(false);
  expect(lintsAlone({ cwd: "repository", fix: false })).toBe(false);
  expect(lintsAlone({ fix: true })).toBe(true);
  expect(lintsAlone({ cwd: "scratch" })).toBe(true);
  expect(lintsAlone({ overrides: [] })).toBe(true);
});

test("concurrent fix cases each return their isolated result", async () => {
  const source = 'const view = <div className="ml-2 text-right" />;';
  const isolated = {
    lines: [],
    source: 'const view = <div className="ms-2 text-end" />;',
  };
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      runSingleRule("no-physical-properties", source, {
        sourcePath: "source.tsx",
        fix: true,
      }),
    ),
  );
  expect(results).toEqual([isolated, isolated, isolated]);
});
