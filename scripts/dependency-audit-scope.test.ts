import { describe, expect, test } from "bun:test";

import {
  auditablePackages,
  dependencyChanges,
  resolutionSource,
  type ResolutionSource,
} from "./dependency-audit-scope";

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
      registry: new Set(["kept", "changed", "added", "duplicate"]),
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

    expect(changes).toEqual({
      added: [],
      changed: [],
      removed: [],
      registry: new Set(["package"]),
    });
    expect(auditablePackages(changes).size).toBe(0);
  });

  test("workspace-only additions do not require an advisory lookup", () => {
    const changes = dependencyChanges(
      lockfile({}),
      lockfile({ workspace: ["@stll/x@workspace:packages/x"] }),
    );
    expect([...auditablePackages(changes)]).toEqual([]);
  });

  test("a mixed diff audits only registry-resolved changed names", () => {
    const changes = dependencyChanges(
      lockfile({ registry: ["registry@1.0.0"] }),
      lockfile({
        registry: ["registry@2.0.0"],
        workspace: ["@stll/x@workspace:packages/x"],
      }),
    );
    expect([...auditablePackages(changes)]).toEqual(["registry"]);
  });

  test("a name with workspace and registry resolutions is audited", () => {
    const changes = dependencyChanges(
      lockfile({}),
      lockfile({
        first: ["mixed@workspace:packages/mixed"],
        second: ["mixed@1.0.0"],
      }),
    );
    expect([...auditablePackages(changes)]).toEqual(["mixed"]);
  });

  test("classifies every resolution source and audits unknown specs", () => {
    const cases = {
      registry: "pkg@1.0.0",
      workspace: "@stll/pkg@workspace:packages/pkg",
      link: "pkg@link:../pkg",
      file: "pkg@file:../pkg.tgz",
      git: "pkg@git@github.com:stella/pkg.git",
      tarball: "pkg@https://example.com/pkg.tgz",
    } as const satisfies Record<ResolutionSource, string>;

    for (const resolution of Object.values(cases)) {
      const source = resolutionSource(resolution);
      expect(cases[source]).toBe(resolution);
    }
    expect(resolutionSource("pkg@catalog:unknown")).toBe("registry");
    const changes = dependencyChanges(
      lockfile({}),
      lockfile({ unknown: ["pkg@catalog:unknown"] }),
    );
    expect([...auditablePackages(changes)]).toEqual(["pkg"]);
  });
});
