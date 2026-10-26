/**
 * The HTTP core under `src/http/` must stay env-free: it is compiled and run
 * without any environment in `src/lib/compiled-http-validation.artifact.test.ts`,
 * and a module that validates the environment at import (`src/env.ts`,
 * `src/env-base.ts`, or anything calling `@t3-oss/env-core`) exits that
 * process before a request is served. This scan walks the runtime import graph
 * from every core module and fails on any such module it reaches, with the
 * import chain that reached it.
 *
 * Followed: relative and `@/api/*` specifiers (resolved as apps/api/tsconfig
 * maps them, `@/api/*` to `./src/*`) in static imports, `export ... from`,
 * `import x = require(...)` and literal `import(...)` / `require(...)` calls.
 * Skipped: `import type` and `export type` declarations, which emit nothing.
 * Under `verbatimModuleSyntax`, an import whose specifiers are all inline
 * `type` still emits a side-effect import, so it is followed. Package
 * specifiers (`@stll/*` and third-party) are leaves: workspace packages never
 * import `@/api/*`, and an `@t3-oss/env-core` import marks its importer.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

const API_ROOT = path.resolve(import.meta.dir, "../..");
const CORE_GLOB = "src/http/**/*.{ts,tsx}";
/** Modules that read and validate the environment when imported. */
const ENV_MODULES = new Set(["src/env.ts", "src/env-base.ts"]);
const ENV_VALIDATOR_PACKAGE = "@t3-oss/env-core";
const ARTIFACT_TEST = "src/lib/compiled-http-validation.artifact.test.ts";

/** Runtime module specifiers of one source file, type-only ones excluded. */
const findRuntimeSpecifiers = (file: string, source: string): string[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const isFile = (absolute: string): boolean =>
  existsSync(absolute) && statSync(absolute).isFile();

/**
 * The API-relative file an API specifier names, `null` for a package, and
 * `undefined` for an API specifier that names no file.
 */
const resolveApiSpecifier = (
  importer: string,
  specifier: string,
): string | null | undefined => {
  let base: string;
  if (specifier.startsWith("@/api/")) {
    base = path.join("src", specifier.slice("@/api/".length));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.join(path.dirname(importer), specifier);
  } else {
    return null;
  }
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ].find((candidate) => isFile(path.join(API_ROOT, candidate)));
};

type EnvReach = { chain: string[]; reason: string };

const findEnvReaches = async (): Promise<{
  roots: string[];
  reaches: EnvReach[];
  unresolved: string[];
}> => {
  const roots = [...new Bun.Glob(CORE_GLOB).scanSync({ cwd: API_ROOT })]
    .filter((file) => !/\.(?:test|spec|d)\.tsx?$/u.test(file))
    .toSorted();
  // Breadth first from every root at once: each chain is a shortest one.
  const parent = new Map<string, string | undefined>(
    roots.map((root) => [root, undefined]),
  );
  const queue = [...roots];
  const reaches: EnvReach[] = [];
  const unresolved: string[] = [];
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at !== undefined;) {
      chain.unshift(at);
      at = parent.get(at);
    }
    return chain;
  };
  // An array iterator also visits the modules pushed while it walks.
  for (const file of queue) {
    if (ENV_MODULES.has(file)) {
      reaches.push({
        chain: chainTo(file),
        reason: "validates the environment",
      });
      continue;
    }
    if (!/\.tsx?$/u.test(file)) {
      continue;
    }
    const source = await Bun.file(path.join(API_ROOT, file)).text();
    for (const specifier of findRuntimeSpecifiers(file, source)) {
      if (specifier === ENV_VALIDATOR_PACKAGE) {
        reaches.push({
          chain: chainTo(file),
          reason: `imports ${ENV_VALIDATOR_PACKAGE}`,
        });
        continue;
      }
      const resolved = resolveApiSpecifier(file, specifier);
      if (resolved === undefined) {
        unresolved.push(`${file} imports ${specifier}`);
      } else if (resolved !== null && !parent.has(resolved)) {
        parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }
  return { roots, reaches, unresolved };
};

describe("env-free HTTP core", () => {
  test("collects runtime module specifiers and skips type-only declarations", () => {
    const sample = [
      'import { a } from "./value";',
      'import type { B } from "./type-only";',
      'import { type C } from "./inline-type";',
      'import "./side-effect";',
      'export { d } from "./re-export";',
      'export type { E } from "./type-re-export";',
      'export * from "./star";',
      'const lazy = await import("./dynamic");',
      "const computed = await import(name);",
      'const legacy = require("./required");',
    ].join("\n");
    expect(findRuntimeSpecifiers("sample.ts", sample)).toEqual([
      "./value",
      "./inline-type",
      "./side-effect",
      "./re-export",
      "./star",
      "./dynamic",
      "./required",
    ]);
  });

  test("no module the HTTP core imports at runtime reads the environment", async () => {
    const { roots, reaches, unresolved } = await findEnvReaches();
    // The scan started from the core modules the artifact probe compiles.
    expect(roots).toContain("src/http/input.ts");
    expect(roots).toContain("src/http/app.ts");
    // An API import that names no file would hide its subgraph.
    expect(unresolved).toEqual([]);
    expect(
      reaches.map(
        ({ chain, reason }) =>
          `${chain.join(" -> ")} (${reason}); the HTTP core must stay env-free, see ${ARTIFACT_TEST}`,
      ),
    ).toEqual([]);
  });
});
