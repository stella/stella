// Require API-runtime fetch targets to have a statically proven origin.
//
// `fetchWithTimeout` bounds duration; it does not prevent SSRF. A URL sourced
// from request data, an upstream response, or the database can still resolve
// to loopback, link-local, or private infrastructure. Arbitrary outbound
// targets must use `safeOutboundFetchBytes` / `safeOutboundFetchStream`, which
// validate and pin DNS before connecting.
//
// Flagged:
//   fetchWithTimeout(inputUrl, { timeoutMs: 10_000 })
//   fetchWithRetry(record.documentUrl, undefined, options)
//   fetch(dynamicUrl, { signal })
//
// Allowed:
//   fetchWithTimeout("https://api.example.com/v1", { timeoutMs: 10_000 })
//   fetchWithTimeout(`${STATIC_BASE}/items/${id}`, { timeoutMs: 10_000 })
//   fetchWithTimeout(new URL("/v1/items", STATIC_BASE), { timeoutMs: 10_000 })
//   safeOutboundFetchBytes({ url: inputUrl, maxBytes, timeoutMs })
//
// The rule deliberately proves only the destination origin. Dynamic paths,
// query parameters, and fragments are allowed after a static scheme/authority.
// Runtime-configured internal services and explicitly trusted URL producers
// remain narrow, documented boundary exceptions in oxlint.config.ts or at the
// call site; this rule does not attempt whole-program taint analysis.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import path from "node:path";

import {
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const FETCH_MODULES = new Map([
  ["apps/api/src/lib/fetch", new Set(["fetchWithTimeout"])],
  ["@stll/fetch", new Set(["fetchWithTimeout"])],
  [
    "apps/api/src/handlers/case-law/ingestion/adapters/retry",
    new Set(["fetchWithRetry"]),
  ],
]);
const TRUSTED_RESTRICTION_MODULE = "@/api/lib/restrict-outbound-url";
const TRUSTED_RESTRICTION_HELPER = "restrictOutboundUrl";
const TRUSTED_PROVIDER_RESTRICTIONS = new Map([
  [
    "@/api/lib/legal-search/cz-regional-finaldoc-url",
    new Set(["restrictCzRegionalFinaldocUrl"]),
  ],
  [
    "@/api/lib/legal-search/sk-court-document-url",
    new Set(["restrictSkCourtDocumentUrl"]),
  ],
]);
const DYNAMIC_PART = "\u0000";
const ABSOLUTE_ORIGIN = /^(?:https?):\/\/([^/?#]+)/u;
const RESTRICTED_TARGET_ORIGIN = "https://restricted.invalid";
const MUTATING_COLLECTION_METHODS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
const URL_ORIGIN_PROPERTIES = new Set([
  "hash",
  "host",
  "hostname",
  "href",
  "password",
  "port",
  "protocol",
  "toString",
  "username",
]);

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

type ScopeVariable = {
  defs: {
    node: unknown;
    parent: unknown;
    type: string;
  }[];
  references: {
    identifier?: unknown;
    init?: boolean;
    isWrite?: () => boolean;
  }[];
};

type IdentifierNode = ESTree.IdentifierReference;

const isEstreeIdentifier = (node: unknown): node is IdentifierNode =>
  isIdentifier(node) && Array.isArray(node.range);

const templateQuasiText = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    node.type !== "TemplateElement" ||
    typeof node.value !== "object" ||
    node.value === null
  ) {
    return null;
  }
  if ("cooked" in node.value && typeof node.value.cooked === "string") {
    return node.value.cooked;
  }
  return "raw" in node.value && typeof node.value.raw === "string"
    ? node.value.raw
    : null;
};

const hasFixedOrigin = (pattern: string | null): boolean => {
  if (pattern === null) {
    return false;
  }
  const match = ABSOLUTE_ORIGIN.exec(pattern);
  if (!match) {
    return false;
  }
  const authority = match[1] ?? "";
  return (
    authority.length > 0 &&
    !authority.includes(DYNAMIC_PART) &&
    !authority.includes("@")
  );
};

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const isProvablyRelativeUrlPattern = (pattern: string | null): boolean => {
  if (
    pattern === null ||
    pattern.startsWith(DYNAMIC_PART) ||
    pattern.trimStart() !== pattern ||
    pattern.includes("\\")
  ) {
    return false;
  }
  const dynamicIndex = pattern.indexOf(DYNAMIC_PART);
  if (dynamicIndex === -1) {
    return !pattern.startsWith("//") && !/^[a-z][a-z\d+.-]*:/iu.test(pattern);
  }
  const prefix = pattern.slice(0, dynamicIndex);
  if (prefix.startsWith("./") || prefix.startsWith("../")) {
    return true;
  }
  if (prefix.startsWith("/")) {
    return prefix.length > 1 && !prefix.startsWith("//");
  }
  const fixedBoundary = prefix.search(/[/?#]/u);
  return fixedBoundary >= 0 && !prefix.slice(0, fixedBoundary).includes(":");
};

export default eslintCompatPlugin({
  meta: { name: "require-safe-outbound-target" },
  rules: {
    "require-safe-outbound-target": {
      meta: {
        type: "problem",
        messages: {
          uncheckedRedirect:
            "A provider-restricted outbound target must set redirect: " +
            '"error" so a cross-origin redirect cannot escape the validated ' +
            "destination boundary.",
          unsafeOutboundTarget:
            "This outbound request has no statically proven destination " +
            "origin. Route arbitrary URLs through safeOutboundFetchBytes() " +
            "or safeOutboundFetchStream(); for an intentionally trusted " +
            "runtime target, document the exact trust boundary in a narrow " +
            "SAFETY suppression.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        let allowedFiles = new Set<string>();
        let filename = "";
        let fileIsAllowed = false;

        const resolveVariable = (
          identifier: IdentifierNode,
        ): ScopeVariable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const stableInitializer = (variable: ScopeVariable): AstNode | null => {
          if (
            variable.references.some(
              (reference) =>
                reference.init !== true && reference.isWrite?.() === true,
            )
          ) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type === "Variable" &&
              isAstNode(definition.node) &&
              definition.node.type === "VariableDeclarator" &&
              isAstNode(definition.parent) &&
              definition.parent.type === "VariableDeclaration" &&
              definition.parent.kind === "const"
            ) {
              return unwrapExpression(definition.node.init);
            }
          }
          return null;
        };

        const outerTransparentExpression = (identifier: AstNode): AstNode => {
          let current = identifier;
          while (true) {
            const parent = current.parent;
            if (
              !isAstNode(parent) ||
              ![
                "ChainExpression",
                "TSAsExpression",
                "TSSatisfiesExpression",
              ].includes(parent.type) ||
              parent.expression !== current
            ) {
              break;
            }
            current = parent;
          }
          return current;
        };

        const aliasVariableForReference = (
          expression: AstNode,
        ): ScopeVariable | null => {
          const declarator = expression.parent;
          if (
            !isAstNode(declarator) ||
            declarator.type !== "VariableDeclarator" ||
            declarator.init !== expression ||
            !isEstreeIdentifier(declarator.id)
          ) {
            return null;
          }
          return resolveVariable(declarator.id);
        };

        const variableHasOriginMutation = (
          variable: ScopeVariable,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          if (visited.has(variable)) {
            return false;
          }
          const nextVisited = new Set(visited);
          nextVisited.add(variable);
          return variable.references.some((reference) => {
            const identifier = reference.identifier;
            if (!isAstNode(identifier)) {
              return false;
            }
            const expression = outerTransparentExpression(identifier);
            const member = expression.parent;
            if (
              !isAstNode(member) ||
              member.type !== "MemberExpression" ||
              member.object !== expression
            ) {
              const alias = aliasVariableForReference(expression);
              if (
                alias !== null &&
                variableHasOriginMutation(alias, nextVisited)
              ) {
                return true;
              }
              const parent = expression.parent;
              if (
                isAstNode(parent) &&
                (parent.type === "CallExpression" ||
                  parent.type === "NewExpression") &&
                Array.isArray(parent.arguments) &&
                parent.arguments.includes(expression)
              ) {
                return !(
                  parent.type === "CallExpression" &&
                  parent.arguments.at(0) === expression &&
                  (isImportedFetchSink(parent.callee) ||
                    isGlobalFetchSink(parent.callee))
                );
              }
              return (
                isAstNode(parent) &&
                ((parent.type === "ArrayExpression" &&
                  Array.isArray(parent.elements) &&
                  parent.elements.includes(expression)) ||
                  (parent.type === "Property" && parent.value === expression) ||
                  (parent.type === "AssignmentExpression" &&
                    parent.right === expression))
              );
            }
            const parent = member.parent;
            const isWrite =
              isAstNode(parent) &&
              ((parent.type === "AssignmentExpression" &&
                parent.left === member) ||
                (parent.type === "UpdateExpression" &&
                  parent.argument === member) ||
                (parent.type === "UnaryExpression" &&
                  parent.operator === "delete" &&
                  parent.argument === member));
            if (!isWrite) {
              return false;
            }
            const propertyName =
              member.computed === false
                ? getPropertyName(member.property)
                : staticPattern(member.property);
            return (
              (member.computed === true &&
                (propertyName === null ||
                  propertyName.includes(DYNAMIC_PART))) ||
              URL_ORIGIN_PROPERTIES.has(propertyName ?? "")
            );
          });
        };

        const variableHasDeepMutation = (
          variable: ScopeVariable,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          if (visited.has(variable)) {
            return false;
          }
          const nextVisited = new Set(visited);
          nextVisited.add(variable);
          return variable.references.some((reference) => {
            const identifier = reference.identifier;
            if (!isAstNode(identifier)) {
              return false;
            }
            let current = outerTransparentExpression(identifier);
            while (true) {
              const member = current.parent;
              if (
                !isAstNode(member) ||
                member.type !== "MemberExpression" ||
                member.object !== current
              ) {
                break;
              }
              current = member;
              const parent = current.parent;
              if (
                isAstNode(parent) &&
                ((parent.type === "AssignmentExpression" &&
                  parent.left === current) ||
                  (parent.type === "UpdateExpression" &&
                    parent.argument === current) ||
                  (parent.type === "UnaryExpression" &&
                    parent.operator === "delete" &&
                    parent.argument === current))
              ) {
                return true;
              }
              if (
                isAstNode(parent) &&
                parent.type === "CallExpression" &&
                parent.callee === current
              ) {
                const methodName =
                  member.computed === false
                    ? getPropertyName(member.property)
                    : isStringLiteral(member.property)
                      ? member.property.value
                      : null;
                if (
                  methodName !== null &&
                  MUTATING_COLLECTION_METHODS.has(methodName)
                ) {
                  return true;
                }
              }
            }
            const alias = aliasVariableForReference(current);
            if (alias !== null && variableHasDeepMutation(alias, nextVisited)) {
              return true;
            }
            const parent = current.parent;
            return (
              isAstNode(parent) &&
              (parent.type === "CallExpression" ||
                parent.type === "NewExpression") &&
              Array.isArray(parent.arguments) &&
              parent.arguments.includes(current)
            );
          });
        };

        const isMutableUrlValue = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return false;
          }
          if (
            expression.type === "NewExpression" &&
            isIdentifier(expression.callee, "URL")
          ) {
            return true;
          }
          if (expression.type === "ConditionalExpression") {
            return (
              isMutableUrlValue(expression.consequent, visited) ||
              isMutableUrlValue(expression.alternate, visited)
            );
          }
          if (isEstreeIdentifier(expression)) {
            const variable = resolveVariable(expression);
            if (variable === null || visited.has(variable)) {
              return false;
            }
            const initializer = stableInitializer(variable);
            if (initializer === null) {
              return false;
            }
            const nextVisited = new Set(visited);
            nextVisited.add(variable);
            return isMutableUrlValue(initializer, nextVisited);
          }
          if (
            expression.type === "CallExpression" &&
            isEstreeIdentifier(expression.callee)
          ) {
            const imported = importInfo(resolveVariable(expression.callee));
            return (
              (imported?.source === TRUSTED_RESTRICTION_MODULE &&
                imported.importedName === TRUSTED_RESTRICTION_HELPER) ||
              (imported !== null &&
                TRUSTED_PROVIDER_RESTRICTIONS.get(imported.source)?.has(
                  imported.importedName,
                ) === true)
            );
          }
          return false;
        };

        const staticPattern = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): string | null => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return null;
          }
          if (isStringLiteral(expression)) {
            return expression.value;
          }
          if (expression.type === "TemplateLiteral") {
            if (
              !Array.isArray(expression.quasis) ||
              !Array.isArray(expression.expressions) ||
              expression.quasis.length !== expression.expressions.length + 1
            ) {
              return null;
            }
            let pattern = templateQuasiText(expression.quasis.at(0));
            if (pattern === null) {
              return null;
            }
            for (
              let index = 0;
              index < expression.expressions.length;
              index++
            ) {
              const part = staticPattern(
                expression.expressions[index],
                visited,
              );
              pattern += part ?? DYNAMIC_PART;
              const quasi = templateQuasiText(expression.quasis[index + 1]);
              if (quasi === null) {
                return null;
              }
              pattern += quasi;
            }
            return pattern;
          }
          if (
            expression.type === "BinaryExpression" &&
            expression.operator === "+"
          ) {
            const left = staticPattern(expression.left, visited);
            const right = staticPattern(expression.right, visited);
            return `${left ?? DYNAMIC_PART}${right ?? DYNAMIC_PART}`;
          }
          if (isEstreeIdentifier(expression)) {
            const variable = resolveVariable(expression);
            if (variable === null || visited.has(variable)) {
              return null;
            }
            const initializer = stableInitializer(variable);
            if (initializer === null) {
              return null;
            }
            const nextVisited = new Set(visited);
            nextVisited.add(variable);
            if (
              isMutableUrlValue(initializer, nextVisited) &&
              variableHasOriginMutation(variable)
            ) {
              return null;
            }
            return staticPattern(initializer, nextVisited);
          }
          if (expression.type === "ConditionalExpression") {
            const consequent = staticPattern(expression.consequent, visited);
            const alternate = staticPattern(expression.alternate, visited);
            if (!hasFixedOrigin(consequent) || !hasFixedOrigin(alternate)) {
              return null;
            }
            const consequentOrigin = ABSOLUTE_ORIGIN.exec(
              consequent ?? "",
            )?.[0];
            const alternateOrigin = ABSOLUTE_ORIGIN.exec(alternate ?? "")?.[0];
            return consequentOrigin === alternateOrigin
              ? `${consequentOrigin}/${DYNAMIC_PART}`
              : null;
          }
          if (
            expression.type === "NewExpression" &&
            isEstreeIdentifier(expression.callee) &&
            expression.callee.name === "URL" &&
            isGlobalReference(expression.callee) &&
            Array.isArray(expression.arguments)
          ) {
            const direct = staticPattern(expression.arguments.at(0), visited);
            if (hasFixedOrigin(direct)) {
              return direct;
            }
            const base = staticPattern(expression.arguments.at(1), visited);
            return hasFixedOrigin(base) && isProvablyRelativeUrlPattern(direct)
              ? `${base}/${DYNAMIC_PART}`
              : null;
          }
          if (
            expression.type === "CallExpression" &&
            isEstreeIdentifier(expression.callee)
          ) {
            const imported = importInfo(resolveVariable(expression.callee));
            if (
              imported?.source === TRUSTED_RESTRICTION_MODULE &&
              imported.importedName === TRUSTED_RESTRICTION_HELPER &&
              hasStaticRestrictionPolicy(expression, visited)
            ) {
              return `${RESTRICTED_TARGET_ORIGIN}/${DYNAMIC_PART}`;
            }
            if (
              imported !== null &&
              TRUSTED_PROVIDER_RESTRICTIONS.get(imported.source)?.has(
                imported.importedName,
              ) === true
            ) {
              return `${RESTRICTED_TARGET_ORIGIN}/${DYNAMIC_PART}`;
            }
          }
          if (
            expression.type === "CallExpression" &&
            isAstNode(expression.callee) &&
            expression.callee.type === "MemberExpression" &&
            expression.callee.computed === false &&
            isIdentifier(expression.callee.property, "toString")
          ) {
            const receiver = staticPattern(expression.callee.object, visited);
            return hasFixedOrigin(receiver) ? receiver : null;
          }
          if (
            expression.type === "CallExpression" &&
            isAstNode(expression.callee) &&
            expression.callee.type === "MemberExpression" &&
            expression.callee.computed === false &&
            isIdentifier(expression.callee.property, "presign") &&
            isAstNode(expression.callee.object) &&
            expression.callee.object.type === "CallExpression" &&
            isEstreeIdentifier(expression.callee.object.callee)
          ) {
            const imported = importInfo(
              resolveVariable(expression.callee.object.callee),
            );
            if (
              imported?.source === "@/api/lib/s3" &&
              imported.importedName === "getS3"
            ) {
              return `https://presigned.invalid/${DYNAMIC_PART}`;
            }
          }
          return null;
        };

        const objectPropertyValue = (
          object: AstNode,
          name: string,
        ): unknown => {
          if (
            object.type !== "ObjectExpression" ||
            !Array.isArray(object.properties)
          ) {
            return null;
          }
          const matches = object.properties.filter(
            (property) =>
              isAstNode(property) &&
              property.type === "Property" &&
              property.computed === false &&
              property.kind === "init" &&
              getPropertyName(property.key) === name,
          );
          return matches.length === 1 && isAstNode(matches[0])
            ? matches[0].value
            : null;
        };

        const resolveObjectExpression = (
          node: unknown,
          visited: Set<ScopeVariable>,
        ): AstNode | null => {
          const expression = unwrapExpression(node);
          if (expression?.type === "ObjectExpression") {
            return Array.isArray(expression.properties) &&
              expression.properties.every(
                (property) =>
                  isAstNode(property) && property.type !== "SpreadElement",
              )
              ? expression
              : null;
          }
          if (!isEstreeIdentifier(expression)) {
            return null;
          }
          const variable = resolveVariable(expression);
          if (
            variable === null ||
            visited.has(variable) ||
            variableHasDeepMutation(variable)
          ) {
            return null;
          }
          const initializer = stableInitializer(variable);
          if (initializer === null) {
            return null;
          }
          const nextVisited = new Set(visited);
          nextVisited.add(variable);
          return resolveObjectExpression(initializer, nextVisited);
        };

        const staticArrayValues = (
          node: unknown,
          visited: Set<ScopeVariable>,
        ): string[] | null => {
          const expression = unwrapExpression(node);
          if (isEstreeIdentifier(expression)) {
            const variable = resolveVariable(expression);
            if (
              variable === null ||
              visited.has(variable) ||
              variableHasDeepMutation(variable)
            ) {
              return null;
            }
            const initializer = stableInitializer(variable);
            if (initializer === null) {
              return null;
            }
            const nextVisited = new Set(visited);
            nextVisited.add(variable);
            return staticArrayValues(initializer, nextVisited);
          }
          if (
            expression?.type !== "ArrayExpression" ||
            !Array.isArray(expression.elements) ||
            expression.elements.length === 0
          ) {
            return null;
          }
          const values: string[] = [];
          for (const element of expression.elements) {
            const value = staticPattern(element, visited);
            if (value === null || value.includes(DYNAMIC_PART)) {
              return null;
            }
            values.push(value);
          }
          return values;
        };

        const hasStaticRestrictionPolicy = (
          call: AstNode,
          visited: Set<ScopeVariable>,
        ): boolean => {
          if (!Array.isArray(call.arguments)) {
            return false;
          }
          const options = resolveObjectExpression(
            call.arguments.at(0),
            visited,
          );
          if (options === null) {
            return false;
          }
          const policy = resolveObjectExpression(
            objectPropertyValue(options, "hostPolicy"),
            visited,
          );
          if (policy === null) {
            return false;
          }
          const policyType = staticPattern(
            objectPropertyValue(policy, "type"),
            visited,
          );
          const values = staticArrayValues(
            objectPropertyValue(
              policy,
              policyType === "exact-origin" ? "origins" : "suffixes",
            ),
            visited,
          );
          if (values === null) {
            return false;
          }
          if (
            policyType === "exact-origin" &&
            !values.every((value) => /^(?:https?):\/\/[^/?#]+$/u.test(value))
          ) {
            return false;
          }
          if (
            policyType !== "exact-origin" &&
            (policyType !== "https-host-suffix" ||
              !values.every((value) =>
                /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]*[a-z\d])?))*$/iu.test(
                  value,
                ),
              ))
          ) {
            return false;
          }
          const pathPrefixes = objectPropertyValue(options, "pathPrefixes");
          if (pathPrefixes === null) {
            return true;
          }
          const paths = staticArrayValues(pathPrefixes, visited);
          return paths !== null && paths.every((path) => path.startsWith("/"));
        };

        const rejectsRedirects = (optionsNode: unknown): boolean => {
          const options = resolveObjectExpression(optionsNode, new Set());
          return (
            options !== null &&
            staticPattern(objectPropertyValue(options, "redirect")) === "error"
          );
        };

        const importInfo = (
          variable: ScopeVariable | null,
        ): { importedName: string; source: string } | null => {
          if (variable === null) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type !== "ImportBinding" ||
              !isAstNode(definition.node) ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "ImportDeclaration" ||
              !isStringLiteral(definition.parent.source)
            ) {
              continue;
            }
            const importedName = getImportedName(definition.node);
            if (importedName !== null) {
              return {
                importedName,
                source: definition.parent.source.value,
              };
            }
          }
          return null;
        };

        const namespaceImportSource = (
          variable: ScopeVariable | null,
        ): string | null => {
          if (variable === null) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type === "ImportBinding" &&
              isAstNode(definition.node) &&
              definition.node.type === "ImportNamespaceSpecifier" &&
              isAstNode(definition.parent) &&
              definition.parent.type === "ImportDeclaration" &&
              isStringLiteral(definition.parent.source)
            ) {
              return definition.parent.source.value;
            }
          }
          return null;
        };

        const normalizeFetchModuleSource = (importSource: string): string => {
          let source = importSource.replace(/\.[cm]?[jt]sx?$/u, "");
          if (source.startsWith("@/api/")) {
            return `apps/api/src/${source.slice("@/api/".length)}`;
          }
          if (!source.startsWith(".")) {
            return source;
          }
          source = normalizePath(path.resolve(path.dirname(filename), source));
          const apiSourceIndex = source.lastIndexOf("/apps/api/src/");
          return apiSourceIndex >= 0
            ? source.slice(apiSourceIndex + 1)
            : source;
        };

        const isImportedFetchSink = (
          callee: unknown,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          const expression = unwrapExpression(callee);
          if (
            expression?.type === "CallExpression" &&
            isAstNode(expression.callee) &&
            expression.callee.type === "MemberExpression" &&
            ((expression.callee.computed === false &&
              getPropertyName(expression.callee.property) === "bind") ||
              (expression.callee.computed === true &&
                isStringLiteral(expression.callee.property) &&
                expression.callee.property.value === "bind"))
          ) {
            return isImportedFetchSink(expression.callee.object, visited);
          }
          if (
            expression?.type === "MemberExpression" &&
            isEstreeIdentifier(expression.object)
          ) {
            const importedName =
              expression.computed === false
                ? getPropertyName(expression.property)
                : isStringLiteral(expression.property)
                  ? expression.property.value
                  : null;
            const source = namespaceImportSource(
              resolveVariable(expression.object),
            );
            return (
              importedName !== null &&
              source !== null &&
              FETCH_MODULES.get(normalizeFetchModuleSource(source))?.has(
                importedName,
              ) === true
            );
          }
          if (!isEstreeIdentifier(expression)) {
            return false;
          }
          const variable = resolveVariable(expression);
          const imported = importInfo(variable);
          if (imported !== null) {
            if (
              FETCH_MODULES.get(
                normalizeFetchModuleSource(imported.source),
              )?.has(imported.importedName) === true
            ) {
              return true;
            }
          }
          if (variable === null || visited.has(variable)) {
            return false;
          }
          const initializer = stableInitializer(variable);
          if (initializer === null) {
            return false;
          }
          const nextVisited = new Set(visited);
          nextVisited.add(variable);
          return isImportedFetchSink(initializer, nextVisited);
        };

        const isGlobalReference = (identifier: IdentifierNode): boolean => {
          if (context.sourceCode.isGlobalReference(identifier)) {
            return true;
          }
          const variable = resolveVariable(identifier);
          return variable === null || variable.defs.length === 0;
        };

        const isGlobalFetchSink = (
          callee: unknown,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          const expression = unwrapExpression(callee);
          if (
            expression?.type === "CallExpression" &&
            isAstNode(expression.callee) &&
            expression.callee.type === "MemberExpression" &&
            ((expression.callee.computed === false &&
              getPropertyName(expression.callee.property) === "bind") ||
              (expression.callee.computed === true &&
                isStringLiteral(expression.callee.property) &&
                expression.callee.property.value === "bind"))
          ) {
            return isGlobalFetchSink(expression.callee.object, visited);
          }
          if (isEstreeIdentifier(expression)) {
            if (expression.name === "fetch" && isGlobalReference(expression)) {
              return true;
            }
            const variable = resolveVariable(expression);
            if (variable === null || visited.has(variable)) {
              return false;
            }
            const initializer = stableInitializer(variable);
            if (initializer === null) {
              return false;
            }
            const nextVisited = new Set(visited);
            nextVisited.add(variable);
            return isGlobalFetchSink(initializer, nextVisited);
          }
          if (
            expression?.type !== "MemberExpression" ||
            !isEstreeIdentifier(expression.object)
          ) {
            return false;
          }
          const propertyName =
            expression.computed === false && isIdentifier(expression.property)
              ? expression.property.name
              : expression.computed === true &&
                  isStringLiteral(expression.property)
                ? expression.property.value
                : null;
          if (propertyName !== "fetch") {
            return false;
          }
          return (
            ["globalThis", "self", "window"].includes(expression.object.name) &&
            isGlobalReference(expression.object)
          );
        };

        return {
          before() {
            allowedFiles = new Set();
            filename = normalizePath(filenameForContext(context));
            fileIsAllowed = false;
            const options = context.options.at(0);
            if (
              typeof options !== "object" ||
              options === null ||
              !("allowedFiles" in options) ||
              !Array.isArray(options.allowedFiles)
            ) {
              return;
            }
            for (const file of options.allowedFiles) {
              if (typeof file === "string") {
                allowedFiles.add(normalizePath(file));
              }
            }
            for (const allowed of allowedFiles) {
              if (filename === allowed || filename.endsWith(`/${allowed}`)) {
                fileIsAllowed = true;
                break;
              }
            }
          },
          CallExpression(node: unknown) {
            if (
              fileIsAllowed ||
              !isAstNode(node) ||
              !Array.isArray(node.arguments)
            ) {
              return;
            }
            let target: unknown;
            let requestOptions: unknown;
            if (
              isImportedFetchSink(node.callee) ||
              isGlobalFetchSink(node.callee)
            ) {
              target = node.arguments.at(0);
              requestOptions = node.arguments.at(1);
            } else {
              const callee = unwrapExpression(node.callee);
              if (
                callee?.type !== "MemberExpression" ||
                (!isImportedFetchSink(callee.object) &&
                  !isGlobalFetchSink(callee.object))
              ) {
                return;
              }
              const invocation =
                callee.computed === false
                  ? getPropertyName(callee.property)
                  : isStringLiteral(callee.property)
                    ? callee.property.value
                    : null;
              if (invocation === "call") {
                target = node.arguments.at(1);
                requestOptions = node.arguments.at(2);
              } else if (invocation === "apply") {
                const appliedArguments = unwrapExpression(node.arguments.at(1));
                if (
                  appliedArguments?.type === "ArrayExpression" &&
                  Array.isArray(appliedArguments.elements)
                ) {
                  target = appliedArguments.elements.at(0);
                  requestOptions = appliedArguments.elements.at(1);
                } else {
                  target = node.arguments.at(1);
                }
              } else {
                return;
              }
            }
            const pattern = staticPattern(target);
            if (pattern === null || !hasFixedOrigin(pattern)) {
              context.report({
                node: isAstNode(target) ? target : node,
                messageId: "unsafeOutboundTarget",
              });
              return;
            }
            if (
              pattern.startsWith(`${RESTRICTED_TARGET_ORIGIN}/`) &&
              !rejectsRedirects(requestOptions)
            ) {
              context.report({
                node,
                messageId: "uncheckedRedirect",
              });
            }
          },
        };
      },
    },
  },
});
