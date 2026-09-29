import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const apiRoot = path.join(repoRoot, "apps/api/src");
const routeFile = path.join(apiRoot, "handlers/public-knowledge/routes.ts");

// The factory, env, and error translator are trusted boundary modules. Their
// broad shared dependency graphs do not grant a public handler access to data.
const boundaryLeaves = new Set([
  "env.ts",
  "lib/api-handlers.ts",
  "lib/errors/tagged-errors.ts",
]);

const allowedModules = new Set([
  "handlers/public-knowledge/endpoints.ts",
  "handlers/public-knowledge/routes.ts",
  "lib/observability/response-status.ts",
  "lib/array.ts",
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
  "slimdom",
  "valibot",
]);

const importsOf = (file: string): string[] =>
  new Bun.Transpiler({ loader: "ts" })
    .scan(readFileSync(file, "utf-8"))
    .imports.map(({ path: specifier }) => specifier);

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
    const relative = path.relative(apiRoot, file);
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
        unexpectedExternal.add(specifier);
      }
    }
  };
  visit(routeFile);
  expect([...reached].filter((file) => !allowedModules.has(file))).toEqual([]);
  expect([...unexpectedExternal]).toEqual([]);

  // The package export resolves to these two runtime files. Keep their
  // dependencies explicit too, so a later package import cannot add storage.
  const packageRoot = path.join(repoRoot, "packages/template-packs/src");
  expect(importsOf(path.join(packageRoot, "catalogue.ts")).toSorted()).toEqual([
    "./packs.gen",
    "better-result",
    "node:fs",
    "node:path",
  ]);
  expect(importsOf(path.join(packageRoot, "packs.gen.ts"))).toEqual([]);
});
