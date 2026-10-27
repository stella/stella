import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type ParsedSource,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const featureRoot = path.resolve(import.meta.dir, "../../..");
const sourceOf = (relativePath: string) =>
  parseSource(
    relativePath,
    readFileSync(path.join(featureRoot, relativePath), "utf-8"),
  );

const importedCalls = (source: ParsedSource, exportedName: string) => {
  const localNames = new Set<string>();
  for (const statement of source.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type"
    ) {
      continue;
    }
    if (
      exportedName === "useLazyDecisionAnalysis" &&
      statement.source.value !==
        "@/features/case-law/components/case-viewer/analysis/use-lazy-decision-analysis"
    ) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (
        binding.type === "ImportSpecifier" &&
        binding.importKind !== "type" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === exportedName
      ) {
        localNames.add(binding.local.name);
      }
    }
  }
  let calls = 0;
  walk(source.program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      localNames.has(node.callee.name)
    ) {
      calls += 1;
    }
  });
  return calls;
};

describe("shared decision analysis ownership", () => {
  test("the reader and inspector both call the same lazy owner", () => {
    for (const file of [
      "components/case-viewer/decision-workspace.tsx",
      "components/case-decision-inspector-view.tsx",
    ]) {
      const source = sourceOf(file);
      expect(
        importedCalls(source, "useLazyDecisionAnalysis"),
        `${file} must use the shared lazy gate`,
      ).toBe(1);
      expect(importedCalls(source, "useDecisionAnalysis")).toBe(0);
    }
  });

  test("all low-level generation callers belong to the shared lazy gate", () => {
    const callers: string[] = [];
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({
      cwd: featureRoot,
    })) {
      if (/\.(test|gen)\./u.test(file)) {
        continue;
      }
      if (importedCalls(sourceOf(file), "useDecisionAnalysis") > 0) {
        callers.push(file);
      }
    }
    expect(callers).toEqual([
      "components/case-viewer/analysis/use-lazy-decision-analysis.ts",
    ]);
  });
});
