import { expect, test } from "bun:test";

import { selectPrGuards } from "./check-pr-guards.ts";

const ids = (files: readonly string[]) =>
  selectPrGuards(files).map((guard) => guard.id);

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

test("selects ui-api-snapshot and package-api-report when packages/ui changes", () => {
  expect(ids(["packages/ui/src/components/entity-actions.tsx"])).toEqual([
    "ui-api-snapshot",
    "package-api-report",
  ]);
});

test("selects parser-version-guard for case-law ingestion adapters", () => {
  expect(
    ids(["apps/api/src/handlers/case-law/ingestion/adapters/pl-kis.ts"]),
  ).toEqual(["parser-version-guard"]);
});

test("selects design-lint-baseline for web and desktop source changes", () => {
  expect(ids(["apps/web/src/components/app-sidebar.tsx"])).toEqual([
    "design-lint-baseline",
  ]);
});

test("returns no guards for unrelated documentation changes", () => {
  expect(ids(["README.md", "docs/notes.md"])).toEqual([]);
});
