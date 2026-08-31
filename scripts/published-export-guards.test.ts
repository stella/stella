import { describe, expect, test } from "bun:test";

import {
  isExpectedPublishedExportResolution,
  isPublishedTestArtifact,
} from "./published-export-guards";

describe("published export artifact guard", () => {
  test.each([
    "fixtures/board.tsx",
    "dist/fixtures/card.tsx",
    "dist/card.test.ts",
    "dist/card.spec.tsx",
    "dist/card.test.d.ts",
    "dist/card.spec.d.ts",
    "playwright.config.ts",
    "dist/playwright.config.ts",
    "dist/card.playwright.ts",
  ])("rejects %s", (file) => {
    expect(isPublishedTestArtifact(file)).toBe(true);
  });

  test.each(["dist/board.tsx", "dist/card.d.ts", "README.md"])(
    "allows %s",
    (file) => {
      expect(isPublishedTestArtifact(file)).toBe(false);
    },
  );
});

describe("published export resolution guard", () => {
  const packageDir = "/repo/packages/example";

  test("requires built modules to resolve under dist", () => {
    const entry = { import: "./dist/index.js" };

    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/dist/index.js",
      }),
    ).toBe(true);
    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/src/index.ts",
      }),
    ).toBe(false);
  });

  test("requires copied assets to resolve to their declared path", () => {
    const entry = "./capability-catalog.json";

    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/capability-catalog.json",
      }),
    ).toBe(true);
    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/dist/capability-catalog.json",
      }),
    ).toBe(false);
  });
});
