/**
 * Architecture test — folio core is React-free.
 *
 * Defence in depth alongside the `folio-layer-boundaries/no-react-in-core`
 * oxlint rule. Lint can be silenced (config edit, file-scoped disable, or a
 * config typo); this test asserts the same invariant on the actual file tree
 * and fails the suite regardless of lint state.
 *
 * `packages/folio/src/core/` is the headless, framework-neutral core. No file
 * under it may import React, react-dom, or @stll/ui — type-only imports
 * included, since `import type { CSSProperties } from "react"` drags React
 * back into core's type graph. Adapters (React today; a Vue adapter, a Tauri
 * shell, or a Rust core tomorrow) sit on top of this one shared core.
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

// Match the specifier of every static import/export, bare side-effect import
// (`import "./setup"`), and dynamic import (`import("./setup")`). Bounded
// character classes keep matching linear.
const IMPORT_REGEX =
  /\bfrom\s*["'](?<fromSpec>[^"']+)["']|\bimport\s*["'](?<importSpec>[^"']+)["']|\bimport\s*\(\s*["'](?<dynImportSpec>[^"']+)["']\s*\)/gu;

const isForbidden = (specifier: string): boolean => {
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
      return true;
    }
  }
  return false;
};

type ReactImport = { importer: string; specifier: string };

const reactImportsForSource = (
  filePath: string,
  source: string,
): ReactImport[] => {
  const found: ReactImport[] = [];
  for (const match of source.matchAll(IMPORT_REGEX)) {
    const specifier =
      match.groups?.["fromSpec"] ??
      match.groups?.["importSpec"] ??
      match.groups?.["dynImportSpec"];
    if (specifier !== undefined && isForbidden(specifier)) {
      found.push({ importer: filePath, specifier });
    }
  }
  return found;
};

const reactImportsForFile = (filePath: string): ReactImport[] =>
  reactImportsForSource(filePath, readFileSync(filePath, "utf-8"));

// Tests carry synthetic fixture strings (e.g. `from "react"`) on purpose, so
// the production-tree scan skips them. The oxlint rule is AST-based and never
// trips on those string literals; this raw-text regex scan would.
const isTestFile = (relativePath: string): boolean =>
  relativePath.includes("__tests__/") ||
  relativePath.endsWith(".test.ts") ||
  relativePath.endsWith(".test.tsx");

const collectCoreFiles = (): string[] => {
  const glob = new Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const relative of glob.scanSync({ cwd: CORE_DIR })) {
    if (isTestFile(relative)) {
      continue;
    }
    files.push(resolve(CORE_DIR, relative));
  }
  return files;
};

describe("folio core is React-free", () => {
  test("no core file imports react, react-dom, or @stll/ui", () => {
    const violations = collectCoreFiles().flatMap(reactImportsForFile);
    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.importer.replace(CORE_DIR, "<core>")} -> "${v.specifier}"`,
        )
        .join("\n");
      throw new Error(
        "Folio core must stay framework-neutral, but found framework " +
          `imports:\n${formatted}\n\n` +
          "Move framework code into the adapter layer (components/, hooks/, " +
          "paged-editor/). For a shared CSS type, depend on csstype instead " +
          "of React.",
      );
    }
    expect(violations).toEqual([]);
  });
});

describe("folio React-free core — synthetic fixtures", () => {
  const importer = resolve(CORE_DIR, "utils/formatToStyle.ts");

  test("type-only react import is rejected", () => {
    const violations = reactImportsForSource(
      importer,
      'import type { CSSProperties } from "react";',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("react");
  });

  test("react-dom import is rejected", () => {
    const violations = reactImportsForSource(
      importer,
      'import { createPortal } from "react-dom";',
    );
    expect(violations).toHaveLength(1);
  });

  test("@stll/ui import is rejected", () => {
    const violations = reactImportsForSource(
      importer,
      'import { Button } from "@stll/ui/button";',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("@stll/ui/button");
  });

  test("dynamic react import is rejected", () => {
    const violations = reactImportsForSource(
      importer,
      'const react = await import("react");',
    );
    expect(violations).toHaveLength(1);
  });

  test("csstype import is allowed", () => {
    const violations = reactImportsForSource(
      importer,
      'import type { Properties } from "csstype";',
    );
    expect(violations).toEqual([]);
  });

  test("relative core imports are allowed", () => {
    const violations = reactImportsForSource(
      importer,
      'import { resolveColor } from "./colorResolver";',
    );
    expect(violations).toEqual([]);
  });
});
