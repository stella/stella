// Require server-side outbound request targets to have a statically proven
// origin.
//
// `fetchWithTimeout` bounds duration; it does not prevent SSRF. A URL sourced
// from request data, an upstream response, or the database can still resolve
// to loopback, link-local, or private infrastructure. Arbitrary outbound
// targets must use `safeOutboundFetchBytes` / `safeOutboundFetchStream`, which
// validate and pin DNS before connecting.
//
// Outbound requests are recognised by what the callee is bound to, following
// aliased imports, namespace members, destructuring, local aliases, `.bind`,
// `.call` and `.apply`:
//   the fetch wrappers (`fetchWithTimeout`, `fetchWithRetry`) from their
//     owning modules and the modules that re-export them
//   global `fetch` (`globalThis.fetch`, `const { fetch } = globalThis`)
//   `undici` `fetch`, `request` and `stream`
//   `node:http` / `node:https` `request` and `get`
//   `new WebSocket(url)`
//
// Flagged:
//   fetchWithTimeout(inputUrl, { timeoutMs: 10_000 })
//   fetchWithRetry(record.documentUrl, undefined, options)
//   https.request(dynamicUrl)
//   new WebSocket(dynamicUrl)
//
// Allowed:
//   fetchWithTimeout("https://api.example.com/v1", { timeoutMs: 10_000 })
//   fetchWithTimeout(`${STATIC_BASE}/items/${id}`, { timeoutMs: 10_000 })
//   fetchWithTimeout(new URL("/v1/items", STATIC_BASE), { timeoutMs: 10_000 })
//   https.request({ hostname: "api.example.com", path })
//   safeOutboundFetchBytes({ url: inputUrl, maxBytes, timeoutMs })
//
// The rule deliberately proves only the destination origin. Dynamic paths,
// query parameters, and fragments are allowed after a static scheme/authority.
// Runtime-configured internal services and explicitly trusted URL producers
// take a narrow suppression at the call, naming the trust boundary; this rule
// does not attempt whole-program taint analysis.

import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

// Fetch-shaped sinks (target first, request options second), keyed by the
// canonical id of a module that exports or re-exports them.
const FETCH_SOURCES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["@stll/fetch", new Set(["fetchWithTimeout"])],
  ["apps/api/src/lib/fetch", new Set(["fetchWithTimeout"])],
  ["apps/web/src/lib/fetch", new Set(["fetchWithTimeout"])],
  [
    "apps/api/src/handlers/case-law/ingestion/adapters/retry",
    new Set(["fetchWithRetry"]),
  ],
  ["undici", new Set(["fetch", "request", "stream"])],
]);
const NODE_HTTP_MODULES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "node:http",
  "node:https",
]);
const NODE_HTTP_METHODS: ReadonlySet<string> = new Set(["get", "request"]);
const WEBSOCKET_MODULES: ReadonlySet<string> = new Set(["ws"]);
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set([
  "globalThis",
  "self",
  "window",
]);

const TRUSTED_RESTRICTION_MODULE = "apps/api/src/lib/restrict-outbound-url";
const TRUSTED_RESTRICTION_HELPER = "restrictOutboundUrl";
const TRUSTED_PROVIDER_RESTRICTIONS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  [
    "apps/api/src/lib/legal-search/cz-regional-finaldoc-url",
    new Set(["restrictCzRegionalFinaldocUrl"]),
  ],
  [
    "apps/api/src/lib/legal-search/sk-court-document-url",
    new Set(["restrictSkCourtDocumentUrl"]),
  ],
]);
const S3_MODULE = "apps/api/src/lib/s3";
const DYNAMIC_PART = "\u0000";
const ABSOLUTE_ORIGIN = /^(?:https?|wss?):\/\/([^/?#]+)/u;
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

type SinkKind = "fetch" | "node-http" | "websocket";

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
  const authority = match.at(1) ?? "";
  return (
    authority.length > 0 &&
    !authority.includes(DYNAMIC_PART) &&
    !authority.includes("@")
  );
};

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

const isBindCall = (node: AstNode | null): node is AstNode =>
  node?.type === "CallExpression" &&
  isAstNode(node.callee) &&
  node.callee.type === "MemberExpression" &&
  memberPropertyName(node.callee) === "bind";

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
            "suppression at this call.",
        },
      },
      createOnce(context) {
        const constInitializer = (variable: Variable): AstNode | null =>
          unwrapExpression(stableInitializer(variable));

        const stableDestructuredProperty = (
          variable: Variable,
        ): { object: AstNode; propertyName: string } | null => {
          const definition = variable.defs.at(0);
          const declarator = definition?.node;
          if (
            definition?.type !== "Variable" ||
            !isAstNode(declarator) ||
            declarator.type !== "VariableDeclarator" ||
            !isAstNode(declarator.id) ||
            declarator.id.type !== "ObjectPattern" ||
            !Array.isArray(declarator.id.properties) ||
            variable.references.some(
              (reference) => !reference.init && reference.isWrite(),
            )
          ) {
            return null;
          }
          const initializer = unwrapExpression(declarator.init);
          if (initializer === null) {
            return null;
          }
          for (const property of declarator.id.properties) {
            if (
              !isAstNode(property) ||
              property.type !== "Property" ||
              property.value !== definition.name
            ) {
              continue;
            }
            const propertyName = property.computed
              ? isStringLiteral(property.key)
                ? property.key.value
                : null
              : getPropertyName(property.key);
            if (propertyName !== null) {
              return { object: initializer, propertyName };
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
        ): Variable | null => {
          const declarator = expression.parent;
          if (
            !isAstNode(declarator) ||
            declarator.type !== "VariableDeclarator" ||
            declarator.init !== expression ||
            !isIdentifierReference(declarator.id)
          ) {
            return null;
          }
          return resolveVariable(context, declarator.id);
        };

        const destructuredAliasVariablesForReference = (
          expression: AstNode,
        ): Variable[] | null => {
          const declarator = expression.parent;
          if (
            !isAstNode(declarator) ||
            declarator.type !== "VariableDeclarator" ||
            declarator.init !== expression ||
            !isAstNode(declarator.id) ||
            declarator.id.type !== "ObjectPattern" ||
            !Array.isArray(declarator.id.properties)
          ) {
            return null;
          }
          const aliases: Variable[] = [];
          for (const property of declarator.id.properties) {
            if (
              !isAstNode(property) ||
              property.type !== "Property" ||
              !isIdentifierReference(property.value)
            ) {
              // Rest, defaults, and nested patterns can retain mutable aliases.
              // Reject their proof rather than guessing about ownership.
              return [];
            }
            const alias = resolveVariable(context, property.value);
            if (alias === null) {
              return [];
            }
            aliases.push(alias);
          }
          return aliases;
        };

        const isGlobalReference = (identifier: unknown): boolean => {
          if (!isIdentifierReference(identifier)) {
            return false;
          }
          if (context.sourceCode.isGlobalReference(identifier)) {
            return true;
          }
          const variable = resolveVariable(context, identifier);
          return variable === null || variable.defs.length === 0;
        };

        const isGlobalObjectExpression = (
          node: unknown,
          visited = new Set<Variable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (!isIdentifierReference(expression)) {
            return false;
          }
          if (
            GLOBAL_OBJECTS.has(expression.name) &&
            isGlobalReference(expression)
          ) {
            return true;
          }
          const variable = resolveVariable(context, expression);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          const initializer = constInitializer(variable);
          return (
            initializer !== null &&
            isGlobalObjectExpression(
              initializer,
              new Set([...visited, variable]),
            )
          );
        };

        // What kind of outbound request calling `callee` makes, or null.
        const sinkKind = (
          callee: unknown,
          visited = new Set<Variable>(),
        ): SinkKind | null => {
          const expression = unwrapExpression(callee);
          if (!isAstNode(expression)) {
            return null;
          }
          if (isBindCall(expression) && isAstNode(expression.callee)) {
            return sinkKind(expression.callee.object, visited);
          }
          // `(secure ? httpsRequest : httpRequest)(...)` calls whichever
          // branch runs.
          if (expression.type === "ConditionalExpression") {
            return (
              sinkKind(expression.consequent, visited) ??
              sinkKind(expression.alternate, visited)
            );
          }
          if (expression.type === "LogicalExpression") {
            return (
              sinkKind(expression.left, visited) ??
              sinkKind(expression.right, visited)
            );
          }
          const resolved = resolveImport(context, expression);
          if (resolved !== null) {
            if (FETCH_SOURCES.get(resolved.moduleId)?.has(resolved.imported)) {
              return "fetch";
            }
            if (
              NODE_HTTP_MODULES.has(resolved.moduleId) &&
              NODE_HTTP_METHODS.has(resolved.imported)
            ) {
              return "node-http";
            }
          }
          if (expression.type === "MemberExpression") {
            const property = memberPropertyName(expression);
            // `https.request` through the module's default export.
            const receiver = resolveImport(context, expression.object);
            if (
              property !== null &&
              receiver !== null &&
              NODE_HTTP_MODULES.has(receiver.moduleId) &&
              receiver.imported === "default" &&
              NODE_HTTP_METHODS.has(property)
            ) {
              return "node-http";
            }
            return property === "fetch" &&
              isGlobalObjectExpression(expression.object)
              ? "fetch"
              : null;
          }
          if (!isIdentifierReference(expression)) {
            return null;
          }
          if (expression.name === "fetch" && isGlobalReference(expression)) {
            return "fetch";
          }
          const variable = resolveVariable(context, expression);
          if (variable === null || visited.has(variable)) {
            return null;
          }
          const destructured = stableDestructuredProperty(variable);
          if (
            destructured?.propertyName === "fetch" &&
            isGlobalObjectExpression(destructured.object)
          ) {
            return "fetch";
          }
          const initializer = constInitializer(variable);
          return initializer === null
            ? null
            : sinkKind(initializer, new Set([...visited, variable]));
        };

        const isWebSocketConstructor = (
          callee: unknown,
          visited = new Set<Variable>(),
        ): boolean => {
          const expression = unwrapExpression(callee);
          if (
            isIdentifierReference(expression) &&
            expression.name === "WebSocket" &&
            isGlobalReference(expression)
          ) {
            return true;
          }
          if (
            expression?.type === "MemberExpression" &&
            memberPropertyName(expression) === "WebSocket" &&
            isGlobalObjectExpression(expression.object)
          ) {
            return true;
          }
          const resolved = resolveImport(context, expression);
          if (resolved !== null) {
            return (
              WEBSOCKET_MODULES.has(resolved.moduleId) &&
              (resolved.imported === "default" ||
                resolved.imported === "WebSocket")
            );
          }
          // `const Socket = WebSocket`: follow a never-reassigned alias.
          if (!isIdentifierReference(expression)) {
            return false;
          }
          const variable = resolveVariable(context, expression);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          const initializer = constInitializer(variable);
          return (
            initializer !== null &&
            isWebSocketConstructor(initializer, new Set([...visited, variable]))
          );
        };

        const variableHasOriginMutation = (
          variable: Variable,
          visited = new Set<Variable>(),
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
                  sinkKind(parent.callee) !== null
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
          variable: Variable,
          visited = new Set<Variable>(),
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
                const methodName = memberPropertyName(member);
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
            const destructuredAliases =
              destructuredAliasVariablesForReference(current);
            if (
              destructuredAliases !== null &&
              (destructuredAliases.length === 0 ||
                destructuredAliases.some((destructuredAlias) =>
                  variableHasDeepMutation(destructuredAlias, nextVisited),
                ))
            ) {
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

        const trustedRestriction = (
          call: AstNode,
        ): "policy" | "provider" | null => {
          const resolved = resolveImport(context, call.callee);
          if (resolved === null) {
            return null;
          }
          if (
            resolved.moduleId === TRUSTED_RESTRICTION_MODULE &&
            resolved.imported === TRUSTED_RESTRICTION_HELPER
          ) {
            return "policy";
          }
          return TRUSTED_PROVIDER_RESTRICTIONS.get(resolved.moduleId)?.has(
            resolved.imported,
          ) === true
            ? "provider"
            : null;
        };

        const isMutableUrlValue = (
          node: unknown,
          visited = new Set<Variable>(),
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
          if (isIdentifierReference(expression)) {
            const variable = resolveVariable(context, expression);
            if (variable === null || visited.has(variable)) {
              return false;
            }
            const initializer = constInitializer(variable);
            return (
              initializer !== null &&
              isMutableUrlValue(initializer, new Set([...visited, variable]))
            );
          }
          return (
            expression.type === "CallExpression" &&
            trustedRestriction(expression) !== null
          );
        };

        // The pattern of a call's result: a local helper's body, a trusted
        // restriction, `URL#toString`, or a Stella-owned presigned URL.
        const callPattern = (
          expression: AstNode,
          visited: Set<Variable>,
        ): string | null => {
          if (expression.type !== "CallExpression") {
            return null;
          }
          // A local expression-bodied helper (`const endpoint = (id) =>
          // `https://host/${id}``) yields its body's pattern; its parameters
          // stay dynamic.
          if (isIdentifierReference(expression.callee)) {
            const variable = resolveVariable(context, expression.callee);
            const helper =
              variable === null || visited.has(variable)
                ? null
                : constInitializer(variable);
            if (
              variable !== null &&
              helper?.type === "ArrowFunctionExpression" &&
              helper.expression === true
            ) {
              return staticPattern(
                helper.body,
                new Set([...visited, variable]),
              );
            }
          }
          const restriction = trustedRestriction(expression);
          if (
            (restriction === "policy" &&
              hasStaticRestrictionPolicy(expression, visited)) ||
            restriction === "provider"
          ) {
            return `${RESTRICTED_TARGET_ORIGIN}/${DYNAMIC_PART}`;
          }
          const callee = unwrapExpression(expression.callee);
          if (callee?.type !== "MemberExpression") {
            return null;
          }
          const method = memberPropertyName(callee);
          if (method === "toString") {
            const receiver = staticPattern(callee.object, visited);
            return hasFixedOrigin(receiver) ? receiver : null;
          }
          const store = unwrapExpression(callee.object);
          if (method !== "presign" || store?.type !== "CallExpression") {
            return null;
          }
          const producer = resolveImport(context, store.callee);
          return producer?.moduleId === S3_MODULE &&
            producer.imported === "getS3"
            ? `https://presigned.invalid/${DYNAMIC_PART}`
            : null;
        };

        const staticPattern = (
          node: unknown,
          visited = new Set<Variable>(),
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
          if (isIdentifierReference(expression)) {
            const variable = resolveVariable(context, expression);
            if (variable === null || visited.has(variable)) {
              return null;
            }
            const initializer = constInitializer(variable);
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
            return consequentOrigin !== undefined &&
              consequentOrigin === alternateOrigin
              ? `${consequentOrigin}/${DYNAMIC_PART}`
              : null;
          }
          if (
            expression.type === "NewExpression" &&
            isIdentifierReference(expression.callee) &&
            expression.callee.name === "URL" &&
            isGlobalReference(expression.callee) &&
            Array.isArray(expression.arguments)
          ) {
            const direct = staticPattern(expression.arguments.at(0), visited);
            if (hasFixedOrigin(direct)) {
              return direct;
            }
            const base = staticPattern(expression.arguments.at(1), visited);
            return base !== null &&
              hasFixedOrigin(base) &&
              isProvablyRelativeUrlPattern(direct)
              ? `${base}/${DYNAMIC_PART}`
              : null;
          }
          return callPattern(expression, visited);
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
          visited: Set<Variable>,
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
          if (!isIdentifierReference(expression)) {
            return null;
          }
          const variable = resolveVariable(context, expression);
          if (
            variable === null ||
            visited.has(variable) ||
            variableHasDeepMutation(variable)
          ) {
            return null;
          }
          const initializer = constInitializer(variable);
          return initializer === null
            ? null
            : resolveObjectExpression(
                initializer,
                new Set([...visited, variable]),
              );
        };

        const staticArrayValues = (
          node: unknown,
          visited: Set<Variable>,
        ): string[] | null => {
          const expression = unwrapExpression(node);
          if (isIdentifierReference(expression)) {
            const variable = resolveVariable(context, expression);
            if (
              variable === null ||
              visited.has(variable) ||
              variableHasDeepMutation(variable)
            ) {
              return null;
            }
            const initializer = constInitializer(variable);
            return initializer === null
              ? null
              : staticArrayValues(initializer, new Set([...visited, variable]));
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
            // `[...BASE_ORIGINS, "https://other.example"]`
            if (isAstNode(element) && element.type === "SpreadElement") {
              const spread = staticArrayValues(element.argument, visited);
              if (spread === null) {
                return null;
              }
              values.push(...spread);
              continue;
            }
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
          visited: Set<Variable>,
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
          return paths?.every((path) => path.startsWith("/")) ?? false;
        };

        // A spread before `redirect: "error"` cannot undo it (the later key
        // wins); a spread after it can.
        const rejectsRedirects = (optionsNode: unknown): boolean => {
          const literal = unwrapExpression(optionsNode);
          if (
            literal?.type === "ObjectExpression" &&
            Array.isArray(literal.properties)
          ) {
            const last = literal.properties.findLast(
              (property) =>
                isAstNode(property) &&
                (property.type === "SpreadElement" ||
                  (property.type === "Property" &&
                    property.computed === false &&
                    getPropertyName(property.key) === "redirect")),
            );
            return (
              isAstNode(last) &&
              last.type === "Property" &&
              staticPattern(last.value) === "error"
            );
          }
          const options = resolveObjectExpression(optionsNode, new Set());
          return (
            options !== null &&
            staticPattern(objectPropertyValue(options, "redirect")) === "error"
          );
        };

        // A node request options object names its destination through
        // `protocol` / `hostname` (or `host`) / `port`.
        const nodeRequestPattern = (node: unknown): string | null => {
          const options = resolveObjectExpression(node, new Set());
          if (options === null) {
            return staticPattern(node);
          }
          const host =
            staticPattern(objectPropertyValue(options, "hostname")) ??
            staticPattern(objectPropertyValue(options, "host"));
          const portValue = objectPropertyValue(options, "port");
          const port = portValue === null ? "" : staticPattern(portValue);
          if (host === null || port === null) {
            return null;
          }
          return `https://${host}${port === "" ? "" : `:${port}`}/${DYNAMIC_PART}`;
        };

        const reportTarget = ({
          call,
          target,
          requestOptions,
          kind,
        }: {
          call: AstNode;
          target: unknown;
          requestOptions: unknown;
          kind: SinkKind;
        }): void => {
          const pattern =
            kind === "node-http"
              ? nodeRequestPattern(target)
              : staticPattern(target);
          if (pattern === null || !hasFixedOrigin(pattern)) {
            context.report({
              node: isAstNode(target) ? target : call,
              messageId: "unsafeOutboundTarget",
            });
            return;
          }
          if (
            kind === "fetch" &&
            pattern.startsWith(`${RESTRICTED_TARGET_ORIGIN}/`) &&
            !rejectsRedirects(requestOptions)
          ) {
            context.report({ node: call, messageId: "uncheckedRedirect" });
          }
        };

        return {
          CallExpression(node: unknown) {
            if (!isAstNode(node) || !Array.isArray(node.arguments)) {
              return;
            }
            const directKind = sinkKind(node.callee);
            if (directKind !== null) {
              reportTarget({
                call: node,
                target: node.arguments.at(0),
                requestOptions: node.arguments.at(1),
                kind: directKind,
              });
              return;
            }
            const callee = unwrapExpression(node.callee);
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const kind = sinkKind(callee.object);
            if (kind === null) {
              return;
            }
            const invocation = memberPropertyName(callee);
            if (invocation === "call") {
              reportTarget({
                call: node,
                target: node.arguments.at(1),
                requestOptions: node.arguments.at(2),
                kind,
              });
              return;
            }
            if (invocation !== "apply") {
              return;
            }
            const appliedArguments = unwrapExpression(node.arguments.at(1));
            const applied =
              appliedArguments?.type === "ArrayExpression" &&
              Array.isArray(appliedArguments.elements)
                ? appliedArguments.elements
                : null;
            reportTarget({
              call: node,
              target: applied === null ? node.arguments.at(1) : applied.at(0),
              requestOptions: applied?.at(1),
              kind,
            });
          },
          NewExpression(node: unknown) {
            if (
              !isAstNode(node) ||
              !Array.isArray(node.arguments) ||
              !isWebSocketConstructor(node.callee)
            ) {
              return;
            }
            reportTarget({
              call: node,
              target: node.arguments.at(0),
              requestOptions: undefined,
              kind: "websocket",
            });
          },
        };
      },
    },
  },
});
