/**
 * Architecture test — layout-bridge layering.
 *
 * `core/layout-bridge/` is split into three concern-based subdirectories that
 * map 1:1 to the future engine/document/render-dom package boundaries:
 *
 *   - engine/  : pure geometry compute (the base layer).
 *   - convert/ : ProseMirror -> FlowBlocks orchestration (sits above engine).
 *   - dom/     : DOM hit-testing / span mapping (sits above engine).
 *
 * The dependency direction is a DAG: convert/ and dom/ MAY import engine/, but
 * engine/ (the base) must import neither convert/ nor dom/. This test asserts
 * that invariant on the actual file tree so a future refactor cannot quietly
 * introduce an upward edge.
 *
 * Negative tests use synthetic fixture strings to prove the analyser flags the
 * offending imports.
 */

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const { resolve } = path;

const ENGINE_DIR = resolve(import.meta.dir, "..", "layout-bridge", "engine");

// Match the specifier of every static import/export, bare side-effect import
// (`import "./setup"`), and dynamic import (`import("./setup")`). Each form is
// a separate pattern: kept apart so no single regex grows complex enough to
// trip the regex-complexity lint, and so the anchoring differs per form.
//
// The static and side-effect forms are anchored to statement position
// (`^[ \t]*` under the `m` flag) so a string literal that merely contains the
// word `from` or `import` before a quoted path cannot masquerade as an import.
// The gap before `from` is bounded by `[^;]` so a multiline named import still
// matches while a trailing string on a later statement cannot be pulled in. The
// dynamic form is genuinely mid-expression, so it stays unanchored; comment
// stripping (below) handles its only practical false-positive source.
const IMPORT_REGEXES = [
  // `import … from "x"`, `export … from "x"`, `export * from "x"`
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["'](?<spec>[^"']+)["']/gmu,
  // bare side-effect import: `import "x"`
  /^[ \t]*import\s*["'](?<spec>[^"']+)["']/gmu,
  // dynamic import: `import("x")`
  /\bimport\s*\(\s*["'](?<spec>[^"']+)["']\s*\)/gu,
] as const;

// A forbidden upward edge: engine/ reaching into a sibling concern. Engine
// files reference siblings relatively, so a violation looks like
// `../convert/toFlowBlocks` or `../dom/findBodyPmSpans`.
const isUpwardEdge = (specifier: string): boolean =>
  /(?:^|\/)(?:convert|dom)\//u.test(specifier);

type LayerViolation = { importer: string; specifier: string };

// Strip block and line comments before the raw-text scan so a comment that
// mentions an import cannot trip it. The line-comment pattern keeps the
// character before `//` so it does not eat a `:` from a `https://` URL.
const stripComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/(?<lead>^|[^:])\/\/[^\n]*/gmu, "$<lead>");

const upwardEdgesForSource = (
  filePath: string,
  source: string,
): LayerViolation[] => {
  const found: LayerViolation[] = [];
  const stripped = stripComments(source);
  for (const regex of IMPORT_REGEXES) {
    for (const match of stripped.matchAll(regex)) {
      const specifier = match.groups?.["spec"];
      if (specifier !== undefined && isUpwardEdge(specifier)) {
        found.push({ importer: filePath, specifier });
      }
    }
  }
  return found;
};

const upwardEdgesForFile = (filePath: string): LayerViolation[] =>
  upwardEdgesForSource(filePath, readFileSync(filePath, "utf-8"));

const isTestFile = (relativePath: string): boolean =>
  relativePath.includes("__tests__/") ||
  relativePath.endsWith(".test.ts") ||
  relativePath.endsWith(".test.tsx");

const collectEngineFiles = (): string[] => {
  const glob = new Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const relative of glob.scanSync({ cwd: ENGINE_DIR })) {
    if (isTestFile(relative)) {
      continue;
    }
    files.push(resolve(ENGINE_DIR, relative));
  }
  return files;
};

describe("layout-bridge engine is the base layer", () => {
  test("no engine file imports from convert/ or dom/", () => {
    const violations = collectEngineFiles().flatMap(upwardEdgesForFile);
    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.importer.replace(ENGINE_DIR, "<engine>")} -> "${v.specifier}"`,
        )
        .join("\n");
      throw new Error(
        "layout-bridge/engine is the base layer and must not import from " +
          `convert/ or dom/, but found upward edges:\n${formatted}\n\n` +
          "Move the shared compute down into engine/, or invert the " +
          "dependency so convert/ and dom/ depend on engine/ instead.",
      );
    }
    expect(violations).toEqual([]);
  });
});

describe("layout-bridge layering — synthetic fixtures", () => {
  const importer = resolve(ENGINE_DIR, "hitTest.ts");

  test("engine -> convert import is rejected", () => {
    const violations = upwardEdgesForSource(
      importer,
      'import { toFlowBlocks } from "../convert/toFlowBlocks";',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("../convert/toFlowBlocks");
  });

  test("engine -> dom import is rejected", () => {
    const violations = upwardEdgesForSource(
      importer,
      'import { findBodyPmSpans } from "../dom/findBodyPmSpans";',
    );
    expect(violations).toHaveLength(1);
  });

  test("engine -> dom dynamic import is rejected", () => {
    const violations = upwardEdgesForSource(
      importer,
      'const mod = await import("../dom/clickToPositionDom");',
    );
    expect(violations).toHaveLength(1);
  });

  test("engine -> engine sibling import is allowed", () => {
    const violations = upwardEdgesForSource(
      importer,
      'import { getPageTop } from "./hitTest";',
    );
    expect(violations).toEqual([]);
  });

  test("engine -> layout-engine import is allowed", () => {
    const violations = upwardEdgesForSource(
      importer,
      'import { measureRun } from "../../layout-engine/measure/measureProvider";',
    );
    expect(violations).toEqual([]);
  });

  test("a string literal that mentions a convert import is ignored", () => {
    const fromInString = upwardEdgesForSource(
      importer,
      'throw new Error("layout failed from \\"../convert/toFlowBlocks\\"");',
    );
    const importInString = upwardEdgesForSource(
      importer,
      'const hint = "run import \\"../dom/findBodyPmSpans\\" first";',
    );
    expect(fromInString).toEqual([]);
    expect(importInString).toEqual([]);
  });

  test("a real import is not confused with a trailing string on a later line", () => {
    const violations = upwardEdgesForSource(
      importer,
      'import { getPageTop } from "./hitTest";\n' +
        'const note = "ported from \\"../convert/toFlowBlocks\\"";',
    );
    expect(violations).toEqual([]);
  });

  test("a comment that mentions a convert import is ignored", () => {
    const lineComment = upwardEdgesForSource(
      importer,
      '// historically: import { x } from "../convert/toFlowBlocks";\nconst x = 1;',
    );
    const blockComment = upwardEdgesForSource(
      importer,
      '/* import { x } from "../dom/findBodyPmSpans" */\nconst y = 2;',
    );
    expect(lineComment).toEqual([]);
    expect(blockComment).toEqual([]);
  });
});
