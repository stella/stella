import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkDocSourceDependencies,
  getDeclaredDocSourceDependencies,
} from "./docs-source-dependency-guard";

describe("documentation source dependency guard", () => {
  test("keeps the live catalog backed by workspace manifests", () => {
    expect(checkDocSourceDependencies(`${import.meta.dir}/..`)).toEqual([]);
  });

  test("excludes dependencies declared only by the documentation MCP", () => {
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

      expect(getDeclaredDocSourceDependencies(root)).not.toContain(
        "mcp-only-dependency",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
