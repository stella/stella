import { describe, expect, test } from "bun:test";

import { DOC_SOURCES } from "../.claude/mcp/doc-sources";
import {
  checkDocSourceDependencies,
  findUndeclaredDocSourceDependencies,
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
});
