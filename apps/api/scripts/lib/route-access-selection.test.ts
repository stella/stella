import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { selectAffectedRouteAccessFixtures } from "./route-access-selection";

const fixtures = [
  {
    id: "first",
    sources: ["apps/api/src/first.ts"],
    sharedSources: ["apps/api/src/bootstrap.ts"],
  },
  {
    id: "second",
    sources: ["apps/api/src/second.ts"],
    sharedSources: ["apps/api/src/bootstrap.ts"],
  },
];

test("PR rows follow owning imports without walking the shared composed bootstrap", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "route-access-scope-"));
  try {
    mkdirSync(path.join(root, "apps/api/src"), { recursive: true });
    mkdirSync(path.join(root, "packages"));
    writeFileSync(
      path.join(root, "apps/api/package.json"),
      JSON.stringify({ name: "@stll/api" }),
    );
    writeFileSync(
      path.join(root, "apps/api/src/first.ts"),
      'import "./dependency"; export const first = 1;',
    );
    writeFileSync(
      path.join(root, "apps/api/src/second.ts"),
      "export const second = 2;",
    );
    writeFileSync(
      path.join(root, "apps/api/src/dependency.ts"),
      "export const dependency = 3;",
    );
    writeFileSync(
      path.join(root, "apps/api/src/bootstrap.ts"),
      'import "./first"; import "./second";',
    );
    expect(
      selectAffectedRouteAccessFixtures(fixtures, {
        root,
        changed: ["apps/api/src/dependency.ts"],
      }).map(({ id }) => id),
    ).toEqual(["first"]);
    expect(
      selectAffectedRouteAccessFixtures(fixtures, {
        root,
        changed: ["apps/api/src/bootstrap.ts"],
      }),
    ).toEqual(fixtures);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual runs retain the matrix and empty PR changes select no rows", () => {
  expect(
    selectAffectedRouteAccessFixtures(fixtures, {
      root: "/unused",
      changed: undefined,
    }),
  ).toEqual(fixtures);
  expect(
    selectAffectedRouteAccessFixtures(fixtures, {
      root: "/unused",
      changed: [],
    }),
  ).toEqual([]);
});

test("shared API configuration changes retain affected matrix rows", () => {
  expect(
    selectAffectedRouteAccessFixtures(fixtures, {
      root: "/unused",
      changed: ["apps/api/package.json"],
    }),
  ).toEqual(fixtures);
});
