import { expect, test } from "bun:test";

import { selectPrGuards } from "./check-pr-guards.ts";

const ids = (files: readonly string[], baseRef?: string) =>
  selectPrGuards(files, baseRef === undefined ? {} : { baseRef }).map(
    (guard) => guard.id,
  );

test("selects oxlint and rollout guards when lint plugins or config change", () => {
  expect(ids([".oxlint-plugins/no-identity-wrapper.ts"])).toEqual([
    "oxlint-plugin-registry",
    "oxlint-effective-config",
    "guard-rollouts",
  ]);
  expect(ids(["oxlint.config.ts"])).toEqual([
    "oxlint-plugin-registry",
    "oxlint-effective-config",
    "guard-rollouts",
  ]);
  expect(ids(["scripts/guard-rollouts/no-identity-wrapper.json"])).toEqual([
    "oxlint-plugin-registry",
    "oxlint-effective-config",
    "guard-rollouts",
  ]);
});

test("selects ui-api-snapshot, package-api-report, and design-lint-baseline when packages/ui changes", () => {
  expect(ids(["packages/ui/src/components/entity-actions.tsx"])).toEqual([
    "ui-api-snapshot",
    "package-api-report",
    "design-lint-baseline",
  ]);
});

test("selects parser-version-guard for case-law, legislation, and legal-ast parser paths", () => {
  expect(
    ids(["apps/api/src/handlers/case-law/ingestion/adapters/pl-kis.ts"]),
  ).toContain("parser-version-guard");
  expect(
    ids(["apps/api/src/handlers/legislation/ingestion/adapters/cz.ts"]),
  ).toContain("parser-version-guard");
  expect(ids(["packages/legal-ast/src/index.ts"])).toContain(
    "parser-version-guard",
  );
});

test("propagates --base to package-api-report and parser-version-guard", () => {
  const guards = selectPrGuards(
    [
      "packages/ui/src/components/button.tsx",
      "apps/api/src/handlers/case-law/ingestion/adapters/pl-kis.ts",
    ],
    { baseRef: "origin/feature-parent" },
  );
  const pkgGuard = guards.find((g) => g.id === "package-api-report");
  const parserGuard = guards.find((g) => g.id === "parser-version-guard");
  expect(pkgGuard?.command.at(-1)).toBe("origin/feature-parent");
  expect(parserGuard?.env?.["BASE_SHA"]).toBe("origin/feature-parent");
});

test("selects test-input-coverage when a script test file changes", () => {
  expect(ids(["scripts/check-pr-guards.test.ts"])).toEqual([
    "test-input-coverage",
  ]);
});

test("returns no guards for unrelated documentation changes", () => {
  expect(ids(["README.md", "docs/notes.md"])).toEqual([]);
});
