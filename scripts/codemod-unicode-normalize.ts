#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const FORMS = new Set(["NFC", "NFD", "NFKC", "NFKD"]);
const MODULE = "@stll/text-normalize";

type Edit = { end: number; start: number; text: string };

const rewriteUnicodeNormalizationOnce = (source: string): string => {
  const file = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits: Edit[] = [];

  const visit = (node: ts.Node): void => {
    let matched = false;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "normalize" &&
      node.arguments.length === 1
    ) {
      const form = node.arguments.at(0);
      const supported =
        form !== undefined &&
        ((ts.isStringLiteral(form) && FORMS.has(form.text)) ||
          (ts.isIdentifier(form) && form.text === "normalization"));
      if (supported) {
        edits.push({
          start: node.getStart(file),
          end: node.end,
          text: `normalizeUnicode(${node.expression.expression.getText(file)}, ${form.getText(file)})`,
        });
        matched = true;
      }
    }
    if (!matched) {
      ts.forEachChild(node, visit);
    }
  };
  visit(file);
  if (edits.length === 0) {
    return source;
  }

  let rewritten = edits
    .toSorted((left, right) => right.start - left.start)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.start) + edit.text + text.slice(edit.end),
      source,
    );
  const importPattern =
    /import\s*\{([^}]*)\}\s*from\s*["']@stll\/text-normalize["'];/u;
  const existing = importPattern.exec(rewritten);
  if (existing) {
    if (!existing[1]?.includes("normalizeUnicode")) {
      rewritten =
        rewritten.slice(0, existing.index) +
        existing[0].replace("{", "{ normalizeUnicode,") +
        rewritten.slice(existing.index + existing[0].length);
    }
    return rewritten;
  }
  return `import { normalizeUnicode } from "${MODULE}";\n\n${rewritten}`;
};

export const rewriteUnicodeNormalization = (source: string): string => {
  let previous = source;
  while (true) {
    const rewritten = rewriteUnicodeNormalizationOnce(previous);
    if (rewritten === previous) {
      return rewritten;
    }
    previous = rewritten;
  }
};

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const files = process.argv
    .slice(2)
    .filter((argument) => argument !== "--check");
  const changed: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf-8");
    const rewritten = rewriteUnicodeNormalization(source);
    if (rewritten === source) {
      continue;
    }
    changed.push(file);
    if (!check) {
      await writeFile(file, rewritten);
    }
  }
  if (check && changed.length > 0) {
    console.error(
      `Unicode normalization codemod pending:\n${changed.join("\n")}`,
    );
    process.exitCode = 1;
  }
}
