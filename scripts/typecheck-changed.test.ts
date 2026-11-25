import { describe, expect, test } from "bun:test";

import { selectTypecheckFiles } from "./typecheck-changed";

describe("selectTypecheckFiles", () => {
  test("selects existing TypeScript source files and excludes declarations and non-TS files", () => {
    const files = selectTypecheckFiles(
      [
        "apps/api/src/lib/auth.ts",
        "apps/web/src/routes/index.tsx",
        "types/world-atlas.d.ts",
        "README.md",
        "package.json",
        "apps/api/src/deleted.ts",
      ],
      { fileExists: (p) => p !== "apps/api/src/deleted.ts" },
    );
    expect(files).toEqual([
      "apps/api/src/lib/auth.ts",
      "apps/web/src/routes/index.tsx",
    ]);
  });

  test("deduplicates and sorts selected paths", () => {
    const files = selectTypecheckFiles(
      ["scripts/b.mts", "scripts/a.cts", "scripts/b.mts"],
      { fileExists: () => true },
    );
    expect(files).toEqual(["scripts/a.cts", "scripts/b.mts"]);
  });
});
