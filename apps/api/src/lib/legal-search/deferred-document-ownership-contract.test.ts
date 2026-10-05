import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import { DEFERRED_DOCUMENT_WRITER_CAPABILITIES } from "@/api/lib/legal-search/deferred-document-writer-contract";

import { canonicalModuleId } from "../../../../../.oxlint-plugins/module-id";
import { OWNERSHIP } from "../../../../../scripts/ownership";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const writerPath = "apps/api/src/lib/legal-search/sk-document-backfill.ts";
const writerModule = writerPath.replace(/\.ts$/u, "");
const ownershipModule =
  "apps/api/src/lib/legal-search/deferred-document-source-ownership";
const acquisitionNames = new Set([
  "ownedDocumentOperation",
  "withDeferredDocumentSourceOwnership",
]);

const parse = (source: string, file = writerPath) =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

const hasExport = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  ts
    .getModifiers(node)
    ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);

const callsAcquisition = (node: ts.Node): boolean => {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    acquisitionNames.has(node.expression.text)
  ) {
    return true;
  }
  return ts.forEachChild(node, callsAcquisition) === true;
};

const writerProblems = (source: string): string[] => {
  const tree = parse(source);
  const problems: string[] = [];
  const publicOperations = new Set([
    "fetchDecisionDocument",
    "claimDocumentFetch",
    "storeBackfilledDocument",
    "markDocumentUnavailable",
    "parkDocumentFetch",
  ]);
  const declarations = new Map<string, ts.VariableDeclaration>();
  for (const statement of tree.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text.endsWith("Owned")
    ) {
      problems.push(
        `${statement.name.text}: raw operation must use the owned arrow function contract`,
      );
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }
      const name = declaration.name.text;
      declarations.set(name, declaration);
      if (!name.endsWith("Owned")) {
        continue;
      }
      publicOperations.add(name.slice(0, -"Owned".length));
      if (hasExport(statement)) {
        problems.push(`${name}: raw operation is exported`);
      }
      if (
        declaration.initializer === undefined ||
        !ts.isArrowFunction(declaration.initializer) ||
        !declaration.initializer.parameters.some((parameter) =>
          parameter.type?.getText(tree).includes("DeferredDocumentSourceFence"),
        )
      ) {
        problems.push(`${name}: raw operation requires a source fence`);
      }
    }
  }
  for (const name of publicOperations) {
    const declaration = declarations.get(name);
    if (
      declaration?.initializer === undefined ||
      !callsAcquisition(declaration.initializer)
    ) {
      problems.push(`${name}: public operation must acquire ownership`);
    }
  }
  for (const statement of tree.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    if (statement.exportClause === undefined) {
      problems.push("writer must not re-export raw modules");
      continue;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if ((element.propertyName ?? element.name).text.endsWith("Owned")) {
          problems.push("writer must not re-export raw operations");
        }
      }
    }
  }
  return problems;
};

const callerProblems = (source: string, file: string): string[] => {
  const tree = parse(source, file);
  const problems: string[] = [];
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const module = canonicalModuleId(statement.moduleSpecifier.text, file);
    if (module === ownershipModule && file !== writerPath) {
      problems.push(`${file}: ownership constructor belongs to the writer`);
    }
    if (module !== writerModule) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text.endsWith("Owned")) {
          problems.push(`${file}: raw operation import`);
        }
      }
    }
  }
  return problems;
};

const capabilityProblems = (
  manifests: readonly { key: string; documentStage: string }[],
  capabilities: Readonly<Record<string, { ownership: string; writer: string }>>,
): string[] =>
  manifests.flatMap((manifest) => {
    if (manifest.documentStage !== "deferred") {
      return [];
    }
    const capability = capabilities[manifest.key];
    return capability?.ownership === "decision-merge-fence" &&
      capability.writer === "fetchDecisionDocument"
      ? []
      : [`${manifest.key}: deferred document writer ownership is required`];
  });

describe("deferred document ownership contract", () => {
  test("every deferred adapter declares the shared writer ownership", () => {
    expect(
      capabilityProblems(
        Object.values(ADAPTER_MANIFESTS),
        DEFERRED_DOCUMENT_WRITER_CAPABILITIES,
      ),
    ).toEqual([]);
  });

  test("a new deferred adapter requires an ownership declaration", () => {
    expect(
      capabilityProblems([{ key: "fixture", documentStage: "deferred" }], {}),
    ).toHaveLength(1);
    expect(
      capabilityProblems([{ key: "fixture", documentStage: "deferred" }], {
        fixture: {
          ownership: "source-ingestion-lease",
          writer: "fetchDecisionDocument",
        },
      }),
    ).toHaveLength(1);
    expect(
      capabilityProblems([{ key: "fixture", documentStage: "deferred" }], {
        fixture: { ownership: "none", writer: "fetchDecisionDocument" },
      }),
    ).toHaveLength(1);
  });

  test("public operations acquire ownership and raw operations require a fence", () => {
    expect(
      writerProblems(readFileSync(path.join(repoRoot, writerPath), "utf-8")),
    ).toEqual([]);
  });

  test("rejects an exported raw operation and an unowned public operation", () => {
    const fixture = `
      export const fetchDecisionDocument = async () => undefined;
      export const storeBackfilledDocumentOwned = async (options: {}) => undefined;
      export const storeBackfilledDocument = async () => undefined;
    `;
    expect(writerProblems(fixture)).toContain(
      "fetchDecisionDocument: public operation must acquire ownership",
    );
    expect(writerProblems(fixture)).toContain(
      "storeBackfilledDocumentOwned: raw operation is exported",
    );
    expect(writerProblems(fixture)).toContain(
      "storeBackfilledDocumentOwned: raw operation requires a source fence",
    );
  });

  test("enumerates writer callers and keeps ownership construction confined", () => {
    const problems: string[] = [];
    for (const file of new Bun.Glob("apps/api/src/**/*.{ts,tsx}").scanSync({
      cwd: repoRoot,
    })) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
        continue;
      }
      const source = readFileSync(path.join(repoRoot, file), "utf-8");
      if (
        source.includes("sk-document-backfill") ||
        source.includes("deferred-document-source-ownership")
      ) {
        problems.push(...callerProblems(source, file));
      }
    }
    expect(problems).toEqual([]);
  });

  test("rejects aliased raw imports and ownership construction outside its owner", () => {
    expect(
      callerProblems(
        `import { storeBackfilledDocumentOwned as store } from "@/api/lib/legal-search/sk-document-backfill";`,
        "apps/api/src/fixture.ts",
      ),
    ).toHaveLength(1);
    expect(
      callerProblems(
        `import { withDeferredDocumentSourceOwnership } from "@/api/lib/legal-search/deferred-document-source-ownership";`,
        "apps/api/src/fixture.ts",
      ),
    ).toHaveLength(1);
  });

  test("the lint ownership declaration confines the ownership helper", () => {
    const entry = OWNERSHIP.find(
      ({ id }) => id === "deferred-document-source-ownership",
    );
    expect(entry?.owner).toEqual([writerPath]);
    expect(entry?.enforcement).toEqual({
      kind: "import",
      specifiers: ["@/api/lib/legal-search/deferred-document-source-ownership"],
      allowed: [],
    });
  });
});
