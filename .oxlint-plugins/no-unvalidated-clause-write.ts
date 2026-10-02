// Clause bodies must be checked before persistence; transport schemas only
// validate their shape. Keep body writers at the operations that own this check.
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  isTestFile,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-unvalidated-clause-write";
const OWNER_PATHS = [
  "apps/api/src/handlers/clauses/create.ts",
  "apps/api/src/handlers/clauses/update.ts",
  "apps/api/src/handlers/clauses/import.ts",
  "apps/api/src/handlers/clauses/variants.ts",
  "apps/api/src/handlers/clauses/versions/restore.ts",
] as const;
const OWNED_FIXTURE =
  ".oxlint-plugins/__fixtures__/no-unvalidated-clause-write.fixture.ts";
const UNOWNED_FIXTURE =
  ".oxlint-plugins/__fixtures__/no-unvalidated-clause-write.fixture.unowned.ts";
const VALIDATOR_MODULE = "@/api/lib/clauses/clause-directives";
const VALIDATOR_NAMES = new Set(["validateClauseBodyDirectives"]);
const TABLE_NAMES = new Set(["clauses", "clauseVariants", "clauseVersions"]);
const isSchemaModule = (specifier: string): boolean =>
  specifier === "@/api/db/schema" ||
  /(?:^|\/)db\/schema(?:\/clauses)?(?:\.ts)?$/u.test(specifier);

const isSearchVectorUpdate = (node: unknown, filename: string): boolean => {
  if (
    !filename.endsWith("apps/api/src/handlers/clauses/search-vector.ts") ||
    !isAstNode(node)
  ) {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (
    callee?.type !== "MemberExpression" ||
    getPropertyName(callee.property) !== "update"
  ) {
    return false;
  }
  const setMember = unwrapExpression(node.parent);
  const setCall =
    setMember?.type === "MemberExpression"
      ? unwrapExpression(setMember.parent)
      : null;
  const update =
    setCall?.type === "CallExpression" && Array.isArray(setCall.arguments)
      ? unwrapExpression(setCall.arguments.at(0))
      : null;
  if (
    setMember?.type !== "MemberExpression" ||
    getPropertyName(setMember.property) !== "set" ||
    update?.type !== "ObjectExpression" ||
    !Array.isArray(update.properties) ||
    update.properties.length !== 1
  ) {
    return false;
  }
  const property = update.properties.at(0);
  return (
    isAstNode(property) && getPropertyName(property.key) === "searchVector"
  );
};

type ValidationScope = { validated: boolean };

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directWrite:
            "Write clause bodies and snapshots through the clause create/update, variant, import, or version restore operations, which validate directives before saving.",
          missingValidation:
            "Propagate validateClauseBodyDirectives with yield* in this owning operation before persisting a clause body or snapshot.",
        },
        schema: [],
      },
      createOnce(context) {
        const scopes: ValidationScope[] = [];
        let isOwner = false;

        type MatchesImportOptions = {
          identifier: unknown;
          specifierMatches: (specifier: string) => boolean;
          names: ReadonlySet<string>;
          namespace?: boolean;
        };
        const matchesImport = ({
          identifier,
          specifierMatches,
          names,
          namespace = false,
        }: MatchesImportOptions): boolean => {
          if (!isIdentifierReference(identifier)) {
            return false;
          }
          const variable = resolveVariable(context, identifier);
          return (
            variable?.defs.some((definition) => {
              if (
                definition.type !== "ImportBinding" ||
                !isAstNode(definition.node) ||
                !isAstNode(definition.parent) ||
                definition.parent.type !== "ImportDeclaration" ||
                definition.parent.importKind === "type" ||
                !isStringLiteral(definition.parent.source) ||
                !specifierMatches(definition.parent.source.value)
              ) {
                return false;
              }
              return namespace
                ? definition.node.type === "ImportNamespaceSpecifier"
                : definition.node.type === "ImportSpecifier" &&
                    definition.node.importKind !== "type" &&
                    names.has(getImportedName(definition.node) ?? "");
            }) ?? false
          );
        };
        const isClauseTable = (node: unknown): boolean => {
          const table = unwrapExpression(node);
          return (
            matchesImport({
              identifier: table,
              specifierMatches: isSchemaModule,
              names: TABLE_NAMES,
            }) ||
            (table?.type === "MemberExpression" &&
              TABLE_NAMES.has(getPropertyName(table.property) ?? "") &&
              matchesImport({
                identifier: table.object,
                specifierMatches: isSchemaModule,
                names: TABLE_NAMES,
                namespace: true,
              }))
          );
        };
        const isValidator = (node: unknown): boolean =>
          matchesImport({
            identifier: node,
            specifierMatches: (specifier) => specifier === VALIDATOR_MODULE,
            names: VALIDATOR_NAMES,
          });
        const pushScope = () => {
          scopes.push({ validated: false });
        };
        const popScope = () => {
          scopes.pop();
        };

        return {
          before() {
            scopes.length = 0;
            const filename = filenameForContext(context);
            isOwner =
              filename.endsWith(OWNED_FIXTURE) ||
              OWNER_PATHS.some((owner) => filename.endsWith(owner));
            return (
              filename.endsWith(OWNED_FIXTURE) ||
              filename.endsWith(UNOWNED_FIXTURE) ||
              (filename.includes("apps/api/src/") && !isTestFile(filename))
            );
          },
          FunctionDeclaration: pushScope,
          "FunctionDeclaration:exit": popScope,
          FunctionExpression: pushScope,
          "FunctionExpression:exit": popScope,
          ArrowFunctionExpression: pushScope,
          "ArrowFunctionExpression:exit": popScope,
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (isValidator(callee)) {
              const parent = unwrapExpression(node.parent);
              if (
                parent?.type !== "YieldExpression" ||
                parent.delegate !== true
              ) {
                return;
              }
              const scope = scopes.at(-1);
              if (scope) {
                scope.validated = true;
              }
              return;
            }
            if (
              callee?.type !== "MemberExpression" ||
              !["insert", "update"].includes(
                getPropertyName(callee.property) ?? "",
              ) ||
              !Array.isArray(node.arguments) ||
              !isClauseTable(node.arguments.at(0))
            ) {
              return;
            }
            // Search index maintenance may only write its own static column.
            if (isSearchVectorUpdate(node, filenameForContext(context))) {
              return;
            }
            if (!isOwner) {
              context.report({ node, messageId: "directWrite" });
              return;
            }
            if (!scopes.some(({ validated }) => validated)) {
              context.report({ node, messageId: "missingValidation" });
            }
          },
        };
      },
    },
  },
});
