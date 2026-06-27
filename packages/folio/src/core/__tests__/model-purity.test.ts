/**
 * Architecture test — the folio model layer is pure data (Seam 2).
 *
 * Defence in depth alongside the `folio-layer-boundaries/model-is-pure-data`
 * oxlint rule. Lint can be silenced (config edit, file-scoped disable, or a
 * config typo); this test asserts the same invariant on the actual file tree
 * and fails the suite regardless of lint state.
 *
 * The model layer is folio's behavior-free data lingua franca: the docx
 * document model (`core/types/*`), the layout/flow data shapes
 * (`layout-engine/types`), and the measurement data shapes
 * (`layout-engine/measure/measureTypes`). None of these may import a behavior
 * or framework dependency — ProseMirror, DOM render, React, `@stll/ui`, or
 * engine behavior (layout-painter, layout-bridge, prosemirror, managers, or any
 * layout-engine module other than `layout-engine/types`). Type-only imports
 * count, since they drag the dependency back into the model's type graph.
 *
 * Negative tests use synthetic fixture strings to prove the analyser flags the
 * offending imports; the lint plugin's leading comment lists the same cases.
 */

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const { resolve } = path;

const CORE_DIR = resolve(import.meta.dir, "..");

const FORBIDDEN_PACKAGES = ["react", "react-dom", "@stll/ui"];

const FORBIDDEN_BEHAVIOR_DIRS = [
  "layout-painter",
  "layout-bridge",
  "prosemirror",
  "managers",
];

// Match the specifier of every static import/export, bare side-effect import
// (`import "./setup"`), and dynamic import (`import("./setup")`). Bounded
// character classes keep matching linear.
const IMPORT_REGEX =
  /\bfrom\s*["'](?<fromSpec>[^"']+)["']|\bimport\s*["'](?<importSpec>[^"']+)["']|\bimport\s*\(\s*["'](?<dynImportSpec>[^"']+)["']\s*\)/gu;

const isForbiddenPackage = (specifier: string): boolean => {
  if (specifier.startsWith("prosemirror-")) {
    return true;
  }
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
      return true;
    }
  }
  return false;
};

// Resolve a relative specifier against the importing file's directory into a
// normalized, extension/index-stripped path we can suffix-match. Non-relative
// specifiers return null (handled by the package check instead).
const resolveRelative = (importerPath: string, specifier: string): string => {
  const stack = importerPath.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  let value = stack.join("/");
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    if (value.endsWith(ext)) {
      value = value.slice(0, -ext.length);
      break;
    }
  }
  if (value.endsWith("/index")) {
    value = value.slice(0, -"/index".length);
  }
  return value;
};

const isAllowedEngineTarget = (stripped: string): boolean =>
  stripped.endsWith("/layout-engine/types") ||
  stripped === "layout-engine/types" ||
  stripped.endsWith("/layout-engine/measure/measureTypes") ||
  stripped === "layout-engine/measure/measureTypes";

const resolvesIntoBehaviorDir = (stripped: string): boolean => {
  for (const dir of FORBIDDEN_BEHAVIOR_DIRS) {
    if (
      stripped === dir ||
      stripped.includes(`/${dir}/`) ||
      stripped.endsWith(`/${dir}`) ||
      stripped.startsWith(`${dir}/`)
    ) {
      return true;
    }
  }
  return false;
};

const isForbiddenRelative = (
  importerPath: string,
  specifier: string,
): boolean => {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const stripped = resolveRelative(importerPath, specifier);
  if (resolvesIntoBehaviorDir(stripped)) {
    return true;
  }
  return (
    stripped.includes("/layout-engine/") && !isAllowedEngineTarget(stripped)
  );
};

type ImpureImport = { importer: string; specifier: string };

// Strip block and line comments before the raw-text scan so a comment that
// mentions an import (`from "react"` in prose) cannot trip it. The AST-based
// model-is-pure-data rule is authoritative; this keeps the defence-in-depth
// scan from false-firing on benign comments. The line-comment pattern keeps the
// character before `//` so it does not eat a `:` from a `https://` URL.
const stripComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/(?<lead>^|[^:])\/\/[^\n]*/gmu, "$<lead>");

const impureImportsForSource = (
  filePath: string,
  source: string,
): ImpureImport[] => {
  const found: ImpureImport[] = [];
  for (const match of stripComments(source).matchAll(IMPORT_REGEX)) {
    const specifier =
      match.groups?.["fromSpec"] ??
      match.groups?.["importSpec"] ??
      match.groups?.["dynImportSpec"];
    if (specifier === undefined) {
      continue;
    }
    if (
      isForbiddenPackage(specifier) ||
      isForbiddenRelative(filePath, specifier)
    ) {
      found.push({ importer: filePath, specifier });
    }
  }
  return found;
};

const impureImportsForFile = (filePath: string): ImpureImport[] =>
  impureImportsForSource(filePath, readFileSync(filePath, "utf-8"));

// The model set: the docx document model (types/*, excluding tests) plus the
// layout/flow and measurement data-shape leaves.
const collectModelFiles = (): string[] => {
  const files: string[] = [];
  const typesGlob = new Glob("types/**/*.ts");
  for (const relative of typesGlob.scanSync({ cwd: CORE_DIR })) {
    if (relative.endsWith(".test.ts")) {
      continue;
    }
    files.push(resolve(CORE_DIR, relative));
  }
  files.push(resolve(CORE_DIR, "layout-engine/types.ts"));
  files.push(resolve(CORE_DIR, "layout-engine/measure/measureTypes.ts"));
  return files;
};

describe("folio model layer is pure data", () => {
  test("the model set lists the expected leaf modules", () => {
    // Guard the glob: if the model modules move or vanish, fail loudly rather
    // than silently scanning nothing.
    const files = collectModelFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  test("no model file imports prosemirror, react, @stll/ui, or engine behavior", () => {
    const violations = collectModelFiles().flatMap(impureImportsForFile);
    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.importer.replace(CORE_DIR, "<core>")} -> "${v.specifier}"`,
        )
        .join("\n");
      throw new Error(
        "The folio model layer must stay pure data, but found behavior " +
          `imports:\n${formatted}\n\n` +
          "Move behavior into the layer that owns it (layout-engine, " +
          "layout-bridge, layout-painter, prosemirror, managers) and keep the " +
          "model describing data only.",
      );
    }
    expect(violations).toEqual([]);
  });
});

describe("folio model purity — synthetic fixtures", () => {
  const importer = resolve(CORE_DIR, "types/document.ts");

  test("prosemirror-state import is rejected", () => {
    const violations = impureImportsForSource(
      importer,
      'import { EditorState } from "prosemirror-state";',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("prosemirror-state");
  });

  test("react import is rejected", () => {
    const violations = impureImportsForSource(
      importer,
      'import type { CSSProperties } from "react";',
    );
    expect(violations).toHaveLength(1);
  });

  test("@stll/ui import is rejected", () => {
    const violations = impureImportsForSource(
      importer,
      'import { Button } from "@stll/ui/button";',
    );
    expect(violations).toHaveLength(1);
  });

  test("relative import into a behavior directory is rejected", () => {
    const painter = impureImportsForSource(
      importer,
      'import { renderPage } from "../layout-painter/renderPage";',
    );
    const managers = impureImportsForSource(
      importer,
      'import { DocManager } from "../managers/docManager";',
    );
    const bridge = impureImportsForSource(
      importer,
      'import { measureParagraph } from "../layout-bridge/measuring";',
    );
    expect(painter).toHaveLength(1);
    expect(managers).toHaveLength(1);
    expect(bridge).toHaveLength(1);
  });

  test("relative import into a non-types layout-engine module is rejected", () => {
    const violations = impureImportsForSource(
      importer,
      'import { paginate } from "../layout-engine/paginator";',
    );
    expect(violations).toHaveLength(1);
  });

  test("the docx-core model surface is allowed", () => {
    const violations = impureImportsForSource(
      importer,
      'export type * from "@stll/docx-core/model";',
    );
    expect(violations).toEqual([]);
  });

  test("the pure-data engine leaves are allowed", () => {
    const engineTypes = impureImportsForSource(
      importer,
      'import type { FlowBlock } from "../layout-engine/types";',
    );
    const measureTypes = impureImportsForSource(
      importer,
      'import type { RunMeasurement } from "../layout-engine/measure/measureTypes";',
    );
    expect(engineTypes).toEqual([]);
    expect(measureTypes).toEqual([]);
  });

  test("sibling model imports are allowed", () => {
    const violations = impureImportsForSource(
      importer,
      'import { deriveBlockId } from "./block-id";',
    );
    expect(violations).toEqual([]);
  });

  test("a comment that mentions a behavior import is ignored", () => {
    const lineComment = impureImportsForSource(
      importer,
      '// this module used to import from "prosemirror-state";\nconst x = 1;',
    );
    const blockComment = impureImportsForSource(
      importer,
      '/* historically: import { EditorView } from "prosemirror-view" */\nconst y = 2;',
    );
    expect(lineComment).toEqual([]);
    expect(blockComment).toEqual([]);
  });
});
