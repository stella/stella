import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Node,
  parseSource,
  type VariableDeclarator,
  walk,
} from "@stll/scripts/src/syntax-tree";

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

const parse = (source: string, file = writerPath) => parseSource(file, source);

const callsAcquisition = (node: Node): boolean => {
  let found = false;
  walk(node, (child) => {
    if (
      child.type === "CallExpression" &&
      child.callee.type === "Identifier" &&
      acquisitionNames.has(child.callee.name)
    ) {
      found = true;
    }
  });
  return found;
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
  const declarations = new Map<string, VariableDeclarator>();
  for (const outer of tree.program.body) {
    const statement =
      outer.type === "ExportNamedDeclaration" ? outer.declaration : outer;
    if (
      statement?.type === "FunctionDeclaration" &&
      statement.id?.name.endsWith("Owned")
    ) {
      problems.push(
        `${statement.id.name}: raw operation must use the owned arrow function contract`,
      );
    }
    if (statement?.type !== "VariableDeclaration") {
      continue;
    }
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier") {
        continue;
      }
      const name = declaration.id.name;
      declarations.set(name, declaration);
      if (!name.endsWith("Owned")) {
        continue;
      }
      publicOperations.add(name.slice(0, -"Owned".length));
      if (outer.type === "ExportNamedDeclaration") {
        problems.push(`${name}: raw operation is exported`);
      }
      if (
        declaration.init?.type !== "ArrowFunctionExpression" ||
        !declaration.init.params.some((parameter) => {
          const binding =
            parameter.type === "TSParameterProperty"
              ? parameter.parameter
              : parameter;
          const target =
            binding.type === "AssignmentPattern" ? binding.left : binding;
          const annotation = target.typeAnnotation;
          return (
            annotation !== null &&
            annotation !== undefined &&
            source
              .slice(annotation.start, annotation.end)
              .includes("DeferredDocumentSourceFence")
          );
        })
      ) {
        problems.push(`${name}: raw operation requires a source fence`);
      }
    }
  }
  for (const name of publicOperations) {
    const declaration = declarations.get(name);
    if (!declaration?.init || !callsAcquisition(declaration.init)) {
      problems.push(`${name}: public operation must acquire ownership`);
    }
  }
  for (const statement of tree.program.body) {
    if (statement.type === "ExportAllDeclaration") {
      problems.push("writer must not re-export raw modules");
    }
    if (statement.type === "ExportNamedDeclaration") {
      for (const element of statement.specifiers) {
        const name =
          element.local.type === "Identifier"
            ? element.local.name
            : element.local.value;
        if (name.endsWith("Owned")) {
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
  for (const statement of tree.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const module = canonicalModuleId(statement.source.value, file);
    if (module === ownershipModule && file !== writerPath) {
      problems.push(`${file}: ownership constructor belongs to the writer`);
    }
    if (module !== writerModule) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type !== "ImportSpecifier") {
        continue;
      }
      const name =
        binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value;
      if (name.endsWith("Owned")) {
        problems.push(`${file}: raw operation import`);
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
