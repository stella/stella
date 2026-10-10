import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import * as ts from "typescript";

const SOURCE_ROOT = import.meta.dir;
const EAGER_BOUNDARIES = {
  "lib/account/storage-families.ts": [
    "@/lib/law-search-history/law-search-history.logic",
  ],
  "features/case-law/case-decision-inspector-registration.tsx": [
    "@/features/case-law/components/case-decision-rail-icon",
  ],
  "features/case-law/case-decision-details-inspector-registration.tsx": [
    "@/features/case-law/components/case-decision-rail-icon",
  ],
  "features/statutes/provision-inspector-registration.tsx": [
    "@/features/statutes/provision-inspector.logic",
  ],
  "routes/-protected-app.tsx": [
    "@/lib/organization/feature-access/capability-actions",
    "@/lib/organization/feature-access/action-capabilities.logic",
  ],
  "routes/law/cases/index.tsx": [
    "@/components/public-law-table/public-law-pagination.logic",
    "@/features/case-law/case-law-pages.logic",
  ],
} as const;
const collectStaticImports = (file: string, text: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
        continue;
      }
      const bindings = clause?.namedBindings;
      if (
        clause?.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        imports.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.exportClause;
    if (
      clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly)
    ) {
      continue;
    }
    imports.push(statement.moduleSpecifier.text);
  }
  return imports;
};
const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/u;
const CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
];

type WalkEagerGraphOptions = {
  root: string;
  entry: string;
  forbidden: readonly string[];
  readSource?: (file: string) => string;
  isFile?: (file: string) => boolean;
};

const walkEagerGraph = ({
  root,
  entry,
  forbidden,
  readSource = (file) => readFileSync(file, "utf-8"),
  isFile = (file) => existsSync(file) && statSync(file).isFile(),
}: WalkEagerGraphOptions) => {
  const resolveImport = (specifier: string, from: string) => {
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
      return undefined;
    }
    const base = specifier.startsWith("@/")
      ? nodePath.resolve(root, specifier.slice(2))
      : nodePath.resolve(nodePath.dirname(from), specifier);
    return CANDIDATE_SUFFIXES.map((suffix) => base + suffix).find(
      (candidate) => SCRIPT_EXTENSION.test(candidate) && isFile(candidate),
    );
  };
  const entryFile = nodePath.resolve(root, entry);
  const forbiddenFiles = new Set(
    forbidden.map((specifier) => {
      const file = resolveImport(specifier, entryFile);
      assert.ok(file, `Cannot resolve forbidden module ${specifier}`);
      return file;
    }),
  );
  const visited = new Set<string>();
  const violations: string[] = [];
  const stack = [{ file: entryFile, chain: [entry] }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || visited.has(next.file)) {
      continue;
    }
    visited.add(next.file);
    for (const specifier of collectStaticImports(
      next.file,
      readSource(next.file),
    )) {
      const file = resolveImport(specifier, next.file);
      if (file === undefined) {
        continue;
      }
      const chain = [...next.chain, nodePath.relative(root, file)];
      if (forbiddenFiles.has(file)) {
        violations.push(chain.join(" -> "));
        continue;
      }
      stack.push({ file, chain });
    }
  }
  return { visited, violations };
};

describe("eager route graph", () => {
  test("keeps route-only feature modules behind lazy imports", () => {
    const violations: string[] = [];
    for (const [entry, forbidden] of Object.entries(EAGER_BOUNDARIES)) {
      const graph = walkEagerGraph({ root: SOURCE_ROOT, entry, forbidden });
      expect(graph.visited.size).toBeGreaterThan(1);
      violations.push(...graph.violations);
    }
    expect(violations).toEqual([]);
  });

  test.each([
    'import { value } from "./feature"; export { value };',
    'export { value } from "./feature";',
    'export * from "./feature";',
    'import "./feature";',
  ])("rejects an indirect eager dependency through %s", (mutation) => {
    const root = nodePath.resolve(SOURCE_ROOT, "__virtual_eager_graph__");
    const files = new Map([
      ["entry.ts", 'import { value } from "@/bridge"; export { value };'],
      ["bridge/index.ts", 'export { value } from "../intermediate";'],
      [
        "intermediate.tsx",
        `import type { Feature } from "@/feature";
        export type { Feature } from "./feature";
        import { type Feature as InlineFeature } from "./feature";
        export { type Feature as InlineExport } from "./feature";
        export const value = () => import("./feature");
        const view = <Component {...props} key="fixture" />;`,
      ],
      ["feature.ts", "export type Feature = string; export const value = 1;"],
    ]);
    const options = {
      root,
      entry: "entry.ts",
      forbidden: ["@/feature"],
      isFile: (file: string) => files.has(nodePath.relative(root, file)),
      readSource: (file: string) => {
        const source = files.get(nodePath.relative(root, file));
        assert.ok(source !== undefined, `Missing fixture module ${file}`);
        return source;
      },
    };
    const lazyGraph = walkEagerGraph(options);
    expect(
      [...lazyGraph.visited].map((file) => nodePath.relative(root, file)),
    ).toEqual(["entry.ts", "bridge/index.ts", "intermediate.tsx"]);
    expect(lazyGraph.violations).toEqual([]);
    expect(files.get("intermediate.tsx")).not.toBe(mutation);
    files.set("intermediate.tsx", mutation);
    expect(walkEagerGraph(options).violations).toEqual([
      "entry.ts -> bridge/index.ts -> intermediate.tsx -> feature.ts",
    ]);
  });
});
