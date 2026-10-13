// Proves a local owner boundary, not arbitrary SQL data flow: a citation
// evidence writer must invoke the shared text-revision fence and graph transaction.
import { eslintCompatPlugin } from "@oxlint/plugins";
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import ts from "typescript";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isFileIn,
  isTestFile,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const FENCE_MODULE = "apps/api/src/lib/case-law/text-revision";
const GRAPH_MODULE =
  "apps/api/src/handlers/case-law/citation-graph-transaction";
const FENCES = new Set([
  "citationTextRevisionFence",
  "citationTextRevisionFingerprintFence",
]);
const EVIDENCE_GROUP = "citationTextEvidenceColumns";

/** Read schema declarations without initializing the schema's runtime dependencies. */
export const citationEvidenceFieldsFrom = (contents: string) => {
  const source = ts.createSourceFile(
    "case-law.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations]
      : [],
  );
  const group = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === EVIDENCE_GROUP,
  )?.initializer;
  const table = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "caseLawCitations",
  )?.initializer;
  if (group === undefined || !ts.isObjectLiteralExpression(group)) {
    return panic(
      "citationTextEvidenceColumns must declare the citation evidence columns",
    );
  }
  const columns =
    table !== undefined && ts.isCallExpression(table)
      ? table.arguments.at(1)
      : undefined;
  if (
    columns === undefined ||
    !ts.isObjectLiteralExpression(columns) ||
    !columns.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) &&
        ts.isIdentifier(property.expression) &&
        property.expression.text === EVIDENCE_GROUP,
    )
  ) {
    return panic(
      "citationTextEvidenceColumns is not spread into caseLawCitations",
    );
  }
  const drizzle = new Set<string>();
  const sql = new Set<string>();
  for (const property of group.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      return panic(
        "Citation evidence columns must have explicit property names",
      );
    }
    let builder = property.initializer;
    while (
      ts.isCallExpression(builder) &&
      ts.isPropertyAccessExpression(builder.expression) &&
      ts.isCallExpression(builder.expression.expression)
    ) {
      builder = builder.expression.expression;
    }
    const columnName = ts.isCallExpression(builder)
      ? builder.arguments.at(0)
      : undefined;
    if (
      columnName === undefined ||
      !ts.isStringLiteral(columnName) ||
      !/^[a-z_][a-z0-9_]*$/u.test(columnName.text)
    ) {
      return panic("Citation evidence columns must declare explicit SQL names");
    }
    drizzle.add(property.name.text);
    sql.add(columnName.text);
  }
  if (drizzle.size === 0) {
    return panic("Citation evidence columns cannot be empty");
  }
  if (
    columns.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        drizzle.has(property.name.text),
    )
  ) {
    return panic(
      "Citation evidence columns cannot be overridden outside their schema group",
    );
  }
  return { drizzle, sql };
};

let evidenceFields: ReturnType<typeof citationEvidenceFieldsFrom> | undefined;
const getEvidenceFields = () => {
  evidenceFields ??= citationEvidenceFieldsFrom(
    readFileSync(
      new URL("../apps/api/src/db/schema/case-law.ts", import.meta.url),
      "utf-8",
    ),
  );
  return evidenceFields;
};
const functionAncestors = (node: unknown): AstNode[] => {
  const functions: AstNode[] = [];
  if (!isAstNode(node)) {
    return functions;
  }
  let current = node.parent;
  while (isAstNode(current)) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression" ||
      current.type === "FunctionDeclaration"
    ) {
      functions.push(current);
    }
    current = current.parent;
  }
  return functions;
};

const isDerivedObject = (
  value: unknown,
  fields: ReadonlySet<string>,
): boolean => {
  const object = unwrapExpression(value);
  if (!isAstNode(object) || object.type !== "ObjectExpression") {
    return true;
  }
  if (!Array.isArray(object.properties)) {
    return true;
  }
  return object.properties.some((property) => {
    if (!isAstNode(property)) {
      return false;
    }
    if (property.type === "SpreadElement") {
      return true;
    }
    if (!fields.has(getPropertyName(property.key) ?? "")) {
      return false;
    }
    const expression = unwrapExpression(property.value);
    return !(
      isAstNode(expression) &&
      expression.type === "Literal" &&
      (expression.value === null ||
        (getPropertyName(property.key) === "citedPart" &&
          expression.value === "not-stated"))
    );
  });
};

export default eslintCompatPlugin({
  meta: { name: "citation-evidence-text-fence" },
  rules: {
    "citation-evidence-text-fence": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          missingFence:
            "Write derived citation evidence through a function that invokes the shared citation text-revision fence and canonical graph transaction.",
        },
      },
      createOnce(context) {
        const fields = getEvidenceFields();
        const evidenceAssignment = new RegExp(
          `\\b(?:${[...fields.sql].join("|")})"?\\s*=\\s*(?!NULL\\b)\\S`,
          "iu",
        );
        const writers: AstNode[] = [];
        const guarded = new Set<AstNode>();
        const isCitationTable = (node: unknown) => {
          const binding = resolveImport(context, node);
          return (
            binding?.imported === "caseLawCitations" &&
            binding.moduleId.startsWith("apps/api/src/db/schema")
          );
        };
        const isGraphCallback = (owner: AstNode) => {
          const call = owner.parent;
          if (
            !isAstNode(call) ||
            call.type !== "CallExpression" ||
            !Array.isArray(call.arguments) ||
            call.arguments.at(1) !== owner
          ) {
            return false;
          }
          const binding = resolveImport(context, unwrapExpression(call.callee));
          return (
            binding?.moduleId === GRAPH_MODULE &&
            binding.imported === "runCitationGraphTransaction"
          );
        };
        // This owner publishes decision text and derived citations in one graph-
        // admitted transaction; its decision row lock remains held until commit.
        const isAtomicPublicationOwner = (owner: AstNode) => {
          if (
            !isFileIn(context, [
              "apps/api/src/handlers/case-law/ingestion/pipeline/citations.ts",
            ]) ||
            !isAstNode(owner.parent) ||
            owner.parent.type !== "VariableDeclarator" ||
            !isIdentifier(owner.parent.id, "writeDecisionCitations") ||
            !Array.isArray(owner.params)
          ) {
            return false;
          }
          return owner.params.some((parameter) => {
            if (
              !isIdentifier(parameter, "tx") ||
              !isAstNode(parameter.typeAnnotation)
            ) {
              return false;
            }
            const type = parameter.typeAnnotation.typeAnnotation;
            return (
              isAstNode(type) &&
              type.type === "TSTypeReference" &&
              isIdentifier(type.typeName, "CitationGraphTransaction")
            );
          });
        };
        return {
          before() {
            writers.length = 0;
            guarded.clear();
            return !isTestFile(filenameForContext(context));
          },
          CallExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            const callee = unwrapExpression(node.callee);
            const imported = resolveImport(context, callee);
            if (
              imported?.moduleId === FENCE_MODULE &&
              FENCES.has(imported.imported)
            ) {
              const owner = functionAncestors(node).at(0);
              if (owner !== undefined) {
                guarded.add(owner);
              }
              return;
            }
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !["set", "values"].includes(
                getPropertyName(callee.property) ?? "",
              )
            ) {
              return;
            }
            const mutation = unwrapExpression(callee.object);
            if (!isAstNode(mutation) || mutation.type !== "CallExpression") {
              return;
            }
            const method = unwrapExpression(mutation.callee);
            if (
              !isAstNode(method) ||
              method.type !== "MemberExpression" ||
              !["update", "insert"].includes(
                getPropertyName(method.property) ?? "",
              ) ||
              !Array.isArray(mutation.arguments) ||
              !isCitationTable(mutation.arguments.at(0)) ||
              !Array.isArray(node.arguments) ||
              !isDerivedObject(node.arguments.at(0), fields.drizzle)
            ) {
              return;
            }
            writers.push(node);
          },
          TaggedTemplateExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            const quasi = node.quasi;
            if (
              !isAstNode(quasi) ||
              !Array.isArray(quasi.quasis) ||
              !Array.isArray(quasi.expressions)
            ) {
              return;
            }
            const parts: string[] = [];
            for (const [index, part] of quasi.quasis.entries()) {
              if (
                !isAstNode(part) ||
                typeof part.value !== "object" ||
                !("raw" in part.value)
              ) {
                return;
              }
              parts.push(part.value.raw);
              parts.push(
                isCitationTable(quasi.expressions.at(index))
                  ? "case_law_citations"
                  : "__value__",
              );
            }
            const text = parts.join("");
            if (
              /\b(?:UPDATE|INSERT\s+INTO)\s+case_law_citations\b/iu.test(
                text,
              ) &&
              (evidenceAssignment.test(text) ||
                /\bINSERT\s+INTO\s+case_law_citations\b/iu.test(text))
            ) {
              writers.push(node);
            }
          },
          "Program:exit"() {
            for (const writer of writers) {
              if (
                !functionAncestors(writer).some(
                  (owner) =>
                    (guarded.has(owner) && isGraphCallback(owner)) ||
                    isAtomicPublicationOwner(owner),
                )
              ) {
                context.report({ node: writer, messageId: "missingFence" });
              }
            }
          },
        };
      },
    },
  },
});
