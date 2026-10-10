import { describe, expect, test } from "bun:test";

import { auditablePackages, dependencyChanges } from "./dependency-audit-scope";

const lockfile = (packages: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: 3, packages });

describe("dependency audit diff scope", () => {
  test("classifies added, changed, and removed resolved dependencies", () => {
    const changes = dependencyChanges(
      lockfile({
        kept: ["kept@1.0.0"],
        changed: ["changed@1.0.0"],
        removed: ["removed@1.0.0"],
        duplicate: ["duplicate@1.0.0"],
        "duplicate@2": ["duplicate@2.0.0"],
      }),
      lockfile({
        kept: ["kept@1.0.0"],
        changed: ["changed@1.1.0"],
        added: ["added@1.0.0"],
        duplicate: ["duplicate@1.0.0"],
        "duplicate@3": ["duplicate@3.0.0"],
      }),
    );

    expect(changes).toEqual({
      added: ["added"],
      changed: ["changed", "duplicate"],
      removed: ["removed"],
    });
    expect([...auditablePackages(changes)].toSorted()).toEqual([
      "added",
      "changed",
      "duplicate",
    ]);
  });

  test("an unchanged lockfile produces an empty scope", () => {
    const source = lockfile({ package: ["package@1.0.0"] });
    const changes = dependencyChanges(source, source);

    expect(changes).toEqual({ added: [], changed: [], removed: [] });
    expect(auditablePackages(changes).size).toBe(0);
  });
});
