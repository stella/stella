import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DOC_SOURCES } from "../.claude/mcp/doc-sources";
import {
  checkDocSourceDependencies,
  findUndeclaredDocSourceDependencies,
  getDeclaredDocSourceDependencies,
} from "./docs-source-dependency-guard";

describe("documentation source dependency guard", () => {
  test("rejects every catalog entry without a declared dependency", () => {
    const declared = new Set(
      Object.values(DOC_SOURCES)
        .slice(1)
        .map((source) => source.dependency),
    );

    expect(findUndeclaredDocSourceDependencies(declared)).toEqual([
      `Elysia: ${DOC_SOURCES.Elysia.dependency}`,
    ]);
  });

  test("keeps the live catalog backed by workspace manifests", () => {
    expect(checkDocSourceDependencies(`${import.meta.dir}/..`)).toEqual([]);
  });

  test("discovers dependencies declared by the documentation MCP", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-doc-sources-"));
    try {
      mkdirSync(path.join(root, ".claude", "mcp"), { recursive: true });
      mkdirSync(path.join(root, "apps"));
      mkdirSync(path.join(root, "packages"));
      writeFileSync(path.join(root, "package.json"), "{}");
      writeFileSync(
        path.join(root, ".claude", "mcp", "package.json"),
        JSON.stringify({ dependencies: { "mcp-only-dependency": "1.0.0" } }),
      );

      expect(getDeclaredDocSourceDependencies(root)).toContain(
        "mcp-only-dependency",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
