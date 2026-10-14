import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const apiRoot = path.join(repoRoot, "apps/api/src");
const routeFile = path.join(apiRoot, "handlers/public-knowledge/routes.ts");

// The factory, env, the feature-flag owner, and error translator are trusted
// boundary modules. Their broad shared dependency graphs do not grant a public
// handler access to data.
const boundaryLeaves = new Set([
  "env.ts",
  "lib/deployment-feature.ts",
  "lib/api-handlers.ts",
  "lib/errors/tagged-errors.ts",
]);

const allowedModules = new Set([
  "handlers/public-knowledge/endpoints.ts",
  "handlers/public-knowledge/routes.ts",
  "lib/observability/response-status.ts",
  "lib/security-headers.ts",
  "lib/array.ts",
  "lib/docx-archive.ts",
  "lib/docx/block-directives.ts",
  "lib/docx/discover-clause-slots.ts",
  "lib/docx/discover-placeholders.ts",
  "lib/docx/discover-template.ts",
  "lib/docx/extract-text.ts",
  "lib/docx/field-filters.ts",
  "lib/docx/inline-conditions.ts",
  "lib/docx/ooxml.ts",
  "lib/docx/render-template-preview.ts",
  "lib/docx/rich-patch.ts",
  "lib/docx/row-block-markers.ts",
  "lib/docx/template-warnings.ts",
  "lib/docx/types.ts",
  "lib/template-binding/binding-sources.ts",
  // Parsers take a `ScannedFile`; bundled bytes get one from the security
  // scan, whose graph reads its YARA rules from disk and nothing else.
  "lib/file-scan/archive.ts",
  "lib/file-scan/attached-template.ts",
  "lib/file-scan/document-parsers.ts",
  "lib/file-scan/magic.ts",
  "lib/file-scan/pipeline.ts",
  "lib/file-scan/rejection.ts",
  "lib/file-scan/scan-upload.ts",
  "lib/file-scan/scan.ts",
  "lib/file-scan/scanned-file.ts",
  "lib/file-scan/scanner.ts",
  "lib/file-scan/verdict.ts",
  "lib/file-scan/warnings.ts",
  "lib/file-scan/yara.ts",
  "lib/file-scan/zip.ts",
  // The scan recognises a password-protected Office upload from its bytes
  // alone: a bounded compound-file reader and the encrypted layout check.
  "lib/files/compound-file.ts",
  "lib/files/encrypted-ooxml.ts",
  "lib/runtime-worker-path.ts",
  "lib/sanitize-filename.ts",
  "lib/type-guards.ts",
  "lib/workflow/starter-playbooks.ts",
  "mime-types.ts",
  ...boundaryLeaves,
]);

const allowedExternal = new Set([
  "@litko/yara-x",
  "@stll/agent-input",
  "@stll/api-contract",
  "@stll/collation",
  "@stll/docx-utils",
  "@stll/folio-core",
  "@stll/folio-core/server",
  "@stll/template-conditions",
  "@stll/template-packs",
  "@stll/text-normalize",
  "better-result",
  "elysia",
  "elysia/error",
  "jszip",
  "node:fs",
  "node:path",
  "node:stream",
  "node:zlib",
  "slimdom",
  "valibot",
]);

const importsOf = (file: string): string[] =>
  new Bun.Transpiler({ loader: "ts" })
    .scan(readFileSync(file, "utf-8"))
    .imports.map(({ path: specifier }) => specifier);

const isLiteralData = (node: ts.Expression): boolean => {
  if (ts.isAsExpression(node)) {
    return isLiteralData(node.expression);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        isLiteralData(property.initializer),
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every(isLiteralData);
  }
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
};

const isConstantsOnly = (
  source: string,
  isConstantDependency: (specifier: string) => boolean = () => false,
): boolean => {
  const parsed = ts.createSourceFile("leaf.ts", source, ts.ScriptTarget.Latest);
  return (
    parsed.statements.length > 0 &&
    parsed.statements.every((statement) => {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        const typeOnly =
          clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
          (clause?.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly));
        return (
          typeOnly ||
          (ts.isStringLiteral(statement.moduleSpecifier) &&
            isConstantDependency(statement.moduleSpecifier.text))
        );
      }
      return (
        ts.isVariableStatement(statement) &&
        statement.declarationList.getFirstToken(parsed)?.kind ===
          ts.SyntaxKind.ConstKeyword &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) === true &&
        statement.declarationList.declarations.every(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.initializer !== undefined &&
            isLiteralData(declaration.initializer),
        )
      );
    })
  );
};

const isConstantsOnlyFile = (
  file: string,
  ancestors = new Set<string>(),
): boolean => {
  if (ancestors.has(file)) {
    return false;
  }
  ancestors.add(file);
  const valid = isConstantsOnly(readFileSync(file, "utf-8"), (specifier) => {
    const packageName = specifier.split("/").slice(0, 2).join("/");
    if (
      !specifier.startsWith(".") &&
      !(specifier.startsWith("@stll/") && allowedExternal.has(packageName))
    ) {
      return false;
    }
    return isConstantsOnlyFile(
      Bun.resolveSync(specifier, path.dirname(file)),
      ancestors,
    );
  });
  ancestors.delete(file);
  return valid;
};

const resolveApiImport = (from: string, specifier: string) => {
  const base = specifier.startsWith("@/api/")
    ? path.join(apiRoot, specifier.slice("@/api/".length))
    : path.resolve(path.dirname(from), specifier);
  const resolved = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ].find(existsSync);
  if (!resolved) {
    throw new Error(`Unresolved local import: ${specifier}`);
  }
  return resolved;
};

test("public Knowledge runtime graph is limited to static readers and parsers", () => {
  const reached = new Set<string>();
  const unexpectedExternal = new Set<string>();
  const visit = (file: string) => {
    const relative = repoRelativePath(apiRoot, file);
    if (reached.has(relative)) {
      return;
    }
    reached.add(relative);
    if (boundaryLeaves.has(relative)) {
      return;
    }
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith("@/api/") || specifier.startsWith(".")) {
        visit(resolveApiImport(file, specifier));
      } else if (!allowedExternal.has(specifier)) {
        // An approved package's literal-data leaf adds no executable dependency
        // graph. Inspect its source rather than allowlisting another module.
        const packageName = specifier.split("/").slice(0, 2).join("/");
        if (
          specifier.startsWith("@stll/") &&
          allowedExternal.has(packageName) &&
          isConstantsOnlyFile(Bun.resolveSync(specifier, path.dirname(file)))
        ) {
          continue;
        }
        unexpectedExternal.add(specifier);
      }
    }
  };
  visit(routeFile);
  expect([...reached].filter((file) => !allowedModules.has(file))).toEqual([]);
  expect([...unexpectedExternal]).toEqual([]);

  // The package export resolves to these runtime files. Keep their
  // dependencies explicit too, so a later package import cannot add storage.
  const packageRoot = path.join(repoRoot, "packages/template-packs/src");
  expect(importsOf(path.join(packageRoot, "catalogue.ts")).toSorted()).toEqual([
    "./content-identity",
    "./packs.gen",
    "better-result",
    "node:fs",
    "node:path",
  ]);
  expect(importsOf(path.join(packageRoot, "content-identity.ts"))).toEqual([
    "@stll/sha256/bun",
  ]);
  expect(importsOf(path.join(packageRoot, "packs.gen.ts"))).toEqual([]);
});

test("constant leaves contain only exported literal data", () => {
  expect(
    isConstantsOnly(
      'export const FORMATS = { docx: { family: "word", mimeType: "example/type" } } as const;',
    ),
  ).toBe(true);
  expect(
    isConstantsOnly(
      'export const VALUES = ["example", 1, true, false, null] as const;',
    ),
  ).toBe(true);
});

test("constant leaves admit type-only imports and inspect constant dependencies", () => {
  expect(
    isConstantsOnly(
      'import type { Value } from "example"; export const VALUE = "example";',
    ),
  ).toBe(true);
  expect(
    isConstantsOnly(
      'import { type Value } from "example"; export const VALUE = "example";',
    ),
  ).toBe(true);
  const source =
    'import { VALUE } from "./constants"; export const OTHER = "example";';
  const dependency = 'export const VALUE = "example";';
  expect(isConstantsOnly(source, () => isConstantsOnly(dependency))).toBe(true);
  expect(
    isConstantsOnly(source, () =>
      isConstantsOnly(
        'import JSZip from "jszip"; export const VALUE = "example";',
      ),
    ),
  ).toBe(false);
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("constant file graphs reject jszip dependencies and cycles at every depth", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "constant-leaves-"));
  temporaryDirectories.push(directory);
  const root = path.join(directory, "root.ts");
  const leaf = path.join(directory, "leaf.ts");
  writeFileSync(
    root,
    'import "./first"; import "./second"; export const ROOT = "example";',
  );
  for (const name of ["first", "second"]) {
    writeFileSync(
      path.join(directory, `${name}.ts`),
      'import "./leaf"; export const VALUE = "example";',
    );
  }
  writeFileSync(leaf, 'export const LEAF = "example";');
  expect(isConstantsOnlyFile(root)).toBe(true);
  writeFileSync(
    leaf,
    'import JSZip from "jszip"; export const LEAF = "example";',
  );
  expect(isConstantsOnlyFile(root)).toBe(false);
  writeFileSync(leaf, 'import "./root"; export const LEAF = "example";');
  expect(isConstantsOnlyFile(root)).toBe(false);
});

test.each([
  'import JSZip from "jszip"; export const VALUE = "example";',
  'import "example"; export const VALUE = "example";',
  'export { VALUE } from "example";',
  'export const VALUE = import("example");',
  "export const VALUE = readFile();",
  "export const VALUE = process.env.NODE_ENV;",
  'export const VALUE = { [readKey()]: "example" };',
  "export const VALUE = { ...other };",
  'export const VALUE = { get name() { return "example"; } };',
  'export const VALUE = "example"; run();',
  'export let VALUE = "example";',
  'const VALUE = "example";',
  "",
])(
  "constant leaves reject executable statements and dependencies: %s",
  (source) => {
    expect(isConstantsOnly(source)).toBe(false);
  },
);
