import { describe, expect, test } from "bun:test";

import { selectGatedTestFiles } from "../../scripts/run-gated-tests";

describe("gated test file selection", () => {
  const root = "/repo/apps/api";
  const discovered = [
    "src/db/first.postgres.test.ts",
    "src/db/second.postgres.test.ts",
  ];

  test("defaults to every discovered gated file", () => {
    expect(
      selectGatedTestFiles({
        discoveredGatedFiles: discovered,
        requestedFiles: [],
        root,
      }),
    ).toEqual({
      type: "selected",
      files: discovered,
    });
  });

  test("normalizes relative and absolute paths and removes duplicates", () => {
    expect(
      selectGatedTestFiles({
        discoveredGatedFiles: discovered,
        requestedFiles: [
          "./src/db/second.postgres.test.ts",
          `${root}/src/db/second.postgres.test.ts`,
        ],
        root,
      }),
    ).toEqual({
      type: "selected",
      files: ["src/db/second.postgres.test.ts"],
    });
  });

  test("rejects files that are not in the discovered gated set", () => {
    expect(
      selectGatedTestFiles({
        discoveredGatedFiles: discovered,
        requestedFiles: ["src/db/ungated.test.ts"],
        root,
      }),
    ).toEqual({
      type: "invalid_file",
      file: "src/db/ungated.test.ts",
    });
  });
});
