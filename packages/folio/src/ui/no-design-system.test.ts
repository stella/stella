/**
 * Package-wide guard: no folio source file imports the app design system
 * (`@stll/ui`). The chrome (toolbars, dialogs, pickers) renders the injectable
 * {@link FolioUIComponents} contract with built-in defaults instead, so the
 * whole package stays self-contained and consumers inject their own UI.
 *
 * `core/__tests__/react-free-core.test.ts` already forbids `@stll/ui` under
 * `core/`; this extends the same boundary to the React chrome layer
 * (`components/`, `ui/`, `paged-editor/`, …), where it previously lived. Bun
 * arch test rather than an oxlint rule so it survives config-merge changes and
 * documents the boundary alongside the code.
 */

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// `src/` root: this file lives in `src/ui/`.
const SRC_DIR = path.resolve(import.meta.dir, "..");

const FORBIDDEN = "@stll/ui";

const IMPORT_REGEX =
  /\bfrom\s*["'](?<fromSpec>[^"']+)["']|\bimport\s*["'](?<importSpec>[^"']+)["']|\bimport\s*\(\s*["'](?<dynImportSpec>[^"']+)["']\s*\)/gu;

// Strip comments before the raw-text scan so prose mentioning the package
// cannot trip it (keeps the char before `//` so it does not eat `https://`).
const stripComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/(?<lead>^|[^:])\/\/[^\n]*/gmu, "$<lead>");

const isForbidden = (specifier: string): boolean =>
  specifier === FORBIDDEN || specifier.startsWith(`${FORBIDDEN}/`);

type Violation = { importer: string; specifier: string };

const violationsForFile = (filePath: string): Violation[] => {
  const found: Violation[] = [];
  const source = stripComments(readFileSync(filePath, "utf-8"));
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

// Test files carry synthetic `@stll/ui` fixture strings on purpose.
const isTestFile = (relativePath: string): boolean =>
  relativePath.includes("__tests__/") ||
  relativePath.endsWith(".test.ts") ||
  relativePath.endsWith(".test.tsx");

const collectSourceFiles = (): string[] => {
  const glob = new Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const relative of glob.scanSync({ cwd: SRC_DIR })) {
    if (!isTestFile(relative)) {
      files.push(path.resolve(SRC_DIR, relative));
    }
  }
  return files;
};

describe("folio does not depend on the app design system", () => {
  test("no folio source file imports @stll/ui", () => {
    const violations = collectSourceFiles().flatMap(violationsForFile);
    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  ${v.importer} -> ${v.specifier}`)
        .join("\n");
      throw new Error(
        `folio must not import @stll/ui; use the injectable FolioUIComponents contract instead:\n${formatted}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
