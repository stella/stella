import { eslintCompatPlugin, type Node } from "@oxlint/plugins";
import { readFileSync } from "node:fs";

import { parseContractDomainLedger } from "../scripts/contract-domain-ledger.ts";
import {
  type AstNode,
  filenameForContext,
  getCalleeName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  resolveVariable,
} from "./utils.ts";

let defaultLedger: ReturnType<typeof parseContractDomainLedger> | null = null;
const readDefaultLedger = () => {
  defaultLedger ??= parseContractDomainLedger(
    readFileSync(
      new URL("../scripts/contract-domain-ledger.json", import.meta.url),
      "utf-8",
    ),
    "contract domain ledger",
  );
  return defaultLedger;
};

const RULE_NAME = "require-contract-domains";
const WEB_ROOT = "apps/web/src/";
const MCP_ROOT = "apps/api/src/mcp/";
const LIMIT_METHODS = new Set([
  "maxLength",
  "minLength",
  "maxSize",
  "maxValue",
  "minValue",
]);
const LIMIT_PROPERTIES = new Set(["maxLength", "minLength", "maxSize", "max"]);

const FIXTURE_SUFFIX =
  ".oxlint-plugins/__fixtures__/require-contract-domains.fixture.tsx";

const relativeFile = (filename: string): string | null => {
  if (filename.endsWith(FIXTURE_SUFFIX)) {
    return `${WEB_ROOT}require-contract-domains.fixture.tsx`;
  }
  for (const root of [WEB_ROOT, MCP_ROOT]) {
    const start = filename.indexOf(root);
    if (start !== -1) {
      return filename.slice(start);
    }
  }
  return null;
};

const declarationName = (node: unknown): string => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (
      (current.type === "VariableDeclarator" ||
        current.type === "FunctionDeclaration" ||
        current.type === "ClassDeclaration") &&
      isIdentifier(current.id)
    ) {
      return current.id.name;
    }
    current = current.parent;
  }
  return "<module>";
};

type ContractTypeOptions = {
  isContractImport: (node: unknown) => boolean;
  isBuiltInArray: (node: unknown) => boolean;
};

// Only a contract type reference constrains the domain; `satisfies string[]`
// and a locally declared union cannot establish parity with the server.
const contractType = (node: unknown, options: ContractTypeOptions): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "TSTypeReference") {
    if (options.isContractImport(node.typeName)) {
      return true;
    }
    if (options.isBuiltInArray(node.typeName)) {
      return contractType(node.typeArguments, options);
    }
    if (isAstNode(node.typeName) && node.typeName.type === "TSQualifiedName") {
      return options.isContractImport(node.typeName.left);
    }
    return false;
  }
  if (node.type === "TSIndexedAccessType") {
    return contractType(node.objectType, options);
  }
  if (node.type === "TSTypeQuery") {
    return options.isContractImport(node.exprName);
  }
  if (node.type === "TSArrayType") {
    return contractType(node.elementType, options);
  }
  if (
    node.type === "TSTypeAnnotation" ||
    node.type === "TSTypeOperator" ||
    node.type === "TSParenthesizedType"
  ) {
    return contractType(node.typeAnnotation, options);
  }
  if (
    node.type === "TSTypeParameterInstantiation" &&
    Array.isArray(node.params)
  ) {
    return node.params.some((param) => contractType(param, options));
  }
  return false;
};

const isContractTyped = (
  node: unknown,
  options: ContractTypeOptions,
): boolean => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (
      current.type === "TSSatisfiesExpression" &&
      contractType(current.typeAnnotation, options)
    ) {
      return true;
    }
    if (current.type === "VariableDeclarator") {
      return (
        isAstNode(current.id) &&
        contractType(current.id.typeAnnotation, options)
      );
    }
    if (
      ![
        "ArrayExpression",
        "TSAsExpression",
        "TSSatisfiesExpression",
        "ParenthesizedExpression",
      ].includes(current.type)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
};

const numericLiteral = (node: unknown): node is AstNode & { value: number } =>
  isAstNode(node) && node.type === "Literal" && typeof node.value === "number";

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              ledger: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["id", "reason"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          contract:
            "Use @stll/api-contract for domains and limits (MCP limits use LIMITS). Site: {{id}}",
          stale:
            "Remove stale site {{id}} from scripts/contract-domain-ledger.json.",
        },
      },
      createOnce(context) {
        let file: string | null = null;
        const isContractImport = (node: unknown): boolean => {
          if (!isIdentifierReference(node)) {
            return false;
          }
          const variable = resolveVariable(context, node);
          return (
            variable?.defs.some((definition) => {
              const declaration: unknown = definition.parent;
              return (
                definition.type === "ImportBinding" &&
                isAstNode(declaration) &&
                declaration.type === "ImportDeclaration" &&
                isStringLiteral(declaration.source) &&
                /^@stll\/api-contract(?:\/|$)/u.test(declaration.source.value)
              );
            }) === true
          );
        };
        const typeOptions = {
          isContractImport,
          isBuiltInArray: (node: unknown): boolean => {
            if (
              !isIdentifierReference(node) ||
              !["Array", "ReadonlyArray"].includes(node.name)
            ) {
              return false;
            }
            const variable = resolveVariable(context, node);
            return variable === null || variable.defs.length === 0;
          },
        };
        let known = new Set<string>();
        let seen = new Set<string>();
        let occurrences = new Map<string, number>();
        const report = (node: Node, kind: string, value: unknown) => {
          if (file === null) {
            return;
          }
          const stem = `${file}::${declarationName(node)}::${kind}:${JSON.stringify(value)}`;
          const occurrence = (occurrences.get(stem) ?? 0) + 1;
          occurrences.set(stem, occurrence);
          const id = `${stem}::${occurrence}`;
          seen.add(id);
          if (!known.has(id)) {
            context.report({ node, messageId: "contract", data: { id } });
          }
        };
        return {
          before() {
            const options = context.options.at(0);
            const configured =
              typeof options === "object" &&
              options !== null &&
              !Array.isArray(options)
                ? options.ledger
                : undefined;
            const ledger =
              configured === undefined
                ? readDefaultLedger()
                : parseContractDomainLedger(
                    JSON.stringify(configured),
                    "contract domain ledger",
                  );
            const current = relativeFile(filenameForContext(context));
            file = current;
            known = new Set(
              current === null
                ? []
                : ledger
                    .filter((entry) => entry.id.startsWith(`${current}::`))
                    .map((entry) => entry.id),
            );
            seen = new Set();
            occurrences = new Map();
          },
          TSAsExpression(node) {
            if (
              !file?.startsWith(WEB_ROOT) ||
              !isAstNode(node.expression) ||
              node.expression.type !== "ArrayExpression" ||
              !isAstNode(node.typeAnnotation) ||
              node.typeAnnotation.type !== "TSTypeReference" ||
              !isIdentifier(node.typeAnnotation.typeName, "const")
            ) {
              return;
            }
            const elements: unknown = node.expression.elements;
            if (!Array.isArray(elements)) {
              return;
            }
            const values = elements.flatMap((element: unknown) =>
              isStringLiteral(element) ? [element.value] : [],
            );
            if (
              values.length < 2 ||
              values.length !== elements.length ||
              isContractTyped(node, typeOptions)
            ) {
              return;
            }
            report(node, "domain", values);
          },
          CallExpression(node) {
            if (file === null) {
              return;
            }
            const name = getCalleeName(node.callee)?.split(".").at(-1);
            if (name === undefined || !LIMIT_METHODS.has(name)) {
              return;
            }
            if (
              file.startsWith(MCP_ROOT) &&
              !["maxLength", "minLength", "maxValue", "minValue"].includes(name)
            ) {
              return;
            }
            const value = node.arguments.at(0);
            if (numericLiteral(value)) {
              report(node, name, value.value);
            }
          },
          JSXAttribute(node) {
            if (
              !file?.startsWith(WEB_ROOT) ||
              !isAstNode(node.name) ||
              typeof node.name.name !== "string" ||
              !LIMIT_PROPERTIES.has(node.name.name)
            ) {
              return;
            }
            if (
              isAstNode(node.value) &&
              numericLiteral(node.value.expression)
            ) {
              report(node, node.name.name, node.value.expression.value);
            }
          },
          Property(node) {
            if (!file?.startsWith(WEB_ROOT)) {
              return;
            }
            const name = getPropertyName(node.key);
            if (
              name !== null &&
              LIMIT_PROPERTIES.has(name) &&
              numericLiteral(node.value)
            ) {
              report(node, name, node.value.value);
            }
          },
          "Program:exit"(node) {
            for (const id of known) {
              if (!seen.has(id)) {
                context.report({ node, messageId: "stale", data: { id } });
              }
            }
          },
        };
      },
    },
  },
});
