import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

import { replayImportClosure } from "../case-law-replay-imports.ts";
import { getPropertyName, isAstNode } from "../utils.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const mayWrite = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type === "CallExpression" &&
    isAstNode(node.callee) &&
    node.callee.type === "MemberExpression" &&
    ["set", "onConflictDoUpdate", "execute", "query", "unsafe"].includes(
      getPropertyName(node.callee.property) ?? "",
    )
  ) {
    return true;
  }
  if (
    node.type === "ReturnStatement" &&
    isAstNode(node.argument) &&
    node.argument.type === "ObjectExpression" &&
    Array.isArray(node.argument.properties)
  ) {
    const keys = node.argument.properties.map((property) =>
      isAstNode(property) && property.type === "Property"
        ? getPropertyName(property.key)
        : null,
    );
    if (keys.includes("set") && keys.includes("where")) {
      return true;
    }
  }
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value) ? value.some(mayWrite) : mayWrite(value)),
  );
};

/** Candidate detection only reduces work; the same enforced rule decides debt. */
export const auditReplayWriters = async (root: string) => {
  const candidates = [...replayImportClosure(root)].flatMap((file) => {
    if (
      file === "apps/api/src/lib/case-law/replay-write.ts" ||
      file.endsWith(".test.ts")
    ) {
      return [];
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    const parsed = parseSync(file, source, { range: true });
    if (parsed.errors.length > 0) {
      panic(`Cannot census ${file}`);
    }
    return mayWrite(parsed.program) ? [{ file, source }] : [];
  });
  const results = await Promise.allSettled(
    candidates.map(async ({ file, source }) => ({
      file,
      lines: await lintSingleRule(
        "no-unguarded-case-law-replay-write",
        source,
        { sourcePath: file, ruleOptions: { mode: "audit" } },
      ),
    })),
  );
  return results
    .flatMap((result) => {
      if (result.status === "rejected") {
        return panic("Replay writer census could not run", result.reason);
      }
      const { file, lines } = result.value;
      return [...new Set(lines)].map((line) => ({ file, line }));
    })
    .toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};
