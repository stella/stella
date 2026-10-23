// Require normal API route tables to mount safe-handler endpoints.
//
// Stella's application endpoints are built by the safe-handler factories
// (`createSafeHandler`, `createSafeRootHandler`, ... in
// `apps/api/src/lib/api-handlers.ts`), which keep schemas, permissions, typed
// error handling, the write contract and the MCP disposition together. A route
// file wires them into a table:
//
//   import readThing from "@/api/handlers/things/read";
//   export const thingsRoute = routes({ "/": { GET: readThing } });
//
// The table's type already refuses a bare function (a `RouteDefinition`
// carries `config`, `access` and `run`), so what is left to police is the
// shape the types accept: a definition that no safe-handler factory built.
// Every method entry (`GET`, `POST`, ...) of a `routes({ ... })` table must be
//
//   - an imported binding (an endpoint module's export),
//   - a call of an imported endpoint builder that takes injected dependencies
//     (`createThing(options)`, a test seam), with no `defineEndpoint.*` call
//     or hand-built definition among its arguments,
//   - a safe-handler factory call, or a same-file `const` bound to any of
//     these (where the endpoint is defined is `no-inline-endpoint-in-routes`'s
//     concern), or
//   - a conditional whose two branches are both of these.
//
// Flagged:
//
//   routes({ "/": { GET: defineEndpoint.member({}, handler) } })  // thin endpoint
//   routes({ "/": { GET: { config: {}, access: "public", run } } }) // hand-built
//   routes(table) / { ...methods }                               // unreadable
//
// The table and each path's method map may be same-file `const` object
// literals; anything else (a spread, a call result, an import) cannot be read
// and is reported, so a definition cannot hide behind it.
//
// Protocol, public, streaming, and dev-only route files that are built from
// `defineEndpoint` disable this rule in oxlint.config.ts with a short
// justification.
//
// `no-direct-handler-config` stays on in those files too. Elysia normalised
// route options in place, which could delete a retained endpoint's
// permissions; the HTTP core takes the definition itself and never writes to
// it, and `RouteDefinition.config` is readonly, so an assignment or `delete`
// is a type error. What the types still accept is a write through a
// function: `Object.assign(endpoint.config, ...)`, `Reflect.set(...)`,
// `Object.defineProperty(...)` and their siblings with a `.config` target.
// The rule reports those, and any assignment, update or `delete` whose target
// reaches through `.config`, in case a cast has removed the readonly.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isSafeHandlerFactory } from "../apps/api/src/lib/safe-handler-factories.ts";
import {
  getCalleeName,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const THIN_ENDPOINT_BUILDER = "defineEndpoint";

// Functions that write to their first argument.
const MUTATING_CALLS: ReadonlySet<string> = new Set([
  "Object.assign",
  "Object.defineProperties",
  "Object.defineProperty",
  "Object.setPrototypeOf",
  "Reflect.defineProperty",
  "Reflect.deleteProperty",
  "Reflect.set",
  "Reflect.setPrototypeOf",
]);

// Whether a member chain passes through a non-computed `.config` access
// (`endpoint.config`, `endpoint.config.permissions`).
const reachesThroughConfig = (node: unknown): boolean => {
  let current = unwrapExpression(node);
  while (current?.type === "MemberExpression") {
    if (
      current.computed === false &&
      getPropertyName(current.property) === "config"
    ) {
      return true;
    }
    current = unwrapExpression(current.object);
  }
  return false;
};

const objectProperties = (node: unknown): unknown[] =>
  isAstNode(node) && Array.isArray(node.properties) ? node.properties : [];

const callArguments = (node: unknown): unknown[] =>
  isAstNode(node) && Array.isArray(node.arguments) ? node.arguments : [];

// `defineEndpoint.public(...)` and its siblings.
const isThinEndpointCall = (node: unknown): boolean => {
  const value = unwrapExpression(node);
  if (value?.type !== "CallExpression") {
    return false;
  }
  const name = getCalleeName(value.callee);
  return name !== null && name.startsWith(`${THIN_ENDPOINT_BUILDER}.`);
};

// An object literal that spells a definition's `run` itself.
const isHandBuiltDefinition = (node: unknown): boolean => {
  const value = unwrapExpression(node);
  return (
    value?.type === "ObjectExpression" &&
    objectProperties(value).some(
      (property) =>
        isAstNode(property) &&
        property.type === "Property" &&
        getPropertyName(property.key) === "run",
    )
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-safe-route-handlers" },
  rules: {
    "no-direct-handler-config": {
      meta: {
        type: "problem",
        messages: {
          noDirectHandlerConfig:
            "Do not write to an endpoint's `config`: the safe-handler " +
            "factory and every census read the definition it built, " +
            "permissions included. Build a new config and a new endpoint " +
            "with the factory instead.",
        },
      },
      createOnce(context) {
        return {
          AssignmentExpression(node) {
            if (reachesThroughConfig(node.left)) {
              context.report({
                node: node.left,
                messageId: "noDirectHandlerConfig",
              });
            }
          },
          UpdateExpression(node) {
            if (reachesThroughConfig(node.argument)) {
              context.report({
                node: node.argument,
                messageId: "noDirectHandlerConfig",
              });
            }
          },
          UnaryExpression(node) {
            if (
              node.operator === "delete" &&
              reachesThroughConfig(node.argument)
            ) {
              context.report({
                node: node.argument,
                messageId: "noDirectHandlerConfig",
              });
            }
          },
          CallExpression(node) {
            const name = getCalleeName(node.callee);
            const target = node.arguments.at(0);
            if (
              name !== null &&
              MUTATING_CALLS.has(name) &&
              reachesThroughConfig(target) &&
              isAstNode(target)
            ) {
              context.report({
                node: target,
                messageId: "noDirectHandlerConfig",
              });
            }
          },
        };
      },
    },
    "require-safe-route-handlers": {
      meta: {
        type: "problem",
        messages: {
          requireSafeHandler:
            "Route {{method}} must mount an endpoint built by a safe-handler " +
            "factory (createSafeHandler, createSafeRootHandler, ... in " +
            "@/api/lib/api-handlers), defined in its own module and imported " +
            "here. defineEndpoint and hand-built definitions belong only in " +
            "the protocol/public/dev route files listed as exceptions in " +
            "oxlint.config.ts.",
          unreadableTable:
            "Write this route table (and each path's method map) as an " +
            "object literal, inline or in a same-file const, with no spread, " +
            "so lint can see that every route mounts a safe-handler endpoint.",
        },
      },
      createOnce(context) {
        // An object literal, inline or behind a same-file const; null otherwise.
        const readObject = (node: unknown): unknown => {
          let current: unknown = unwrapExpression(node);
          const seen = new Set<unknown>();
          while (isIdentifierReference(current) && !seen.has(current)) {
            seen.add(current);
            const variable = resolveVariable(context, current);
            current =
              variable === null
                ? null
                : unwrapExpression(stableInitializer(variable));
          }
          return isAstNode(current) && current.type === "ObjectExpression"
            ? current
            : null;
        };

        const isImportBinding = (node: unknown): boolean => {
          const value = unwrapExpression(node);
          if (!isIdentifierReference(value)) {
            return false;
          }
          const variable = resolveVariable(context, value);
          return (
            variable !== null &&
            variable.defs.length === 1 &&
            variable.defs[0]?.type === "ImportBinding"
          );
        };

        const isSafeEndpoint = (node: unknown, seen: Set<unknown>): boolean => {
          const value = unwrapExpression(node);
          if (value === null || seen.has(value)) {
            return false;
          }
          seen.add(value);
          if (value.type === "ConditionalExpression") {
            return (
              isSafeEndpoint(value.consequent, seen) &&
              isSafeEndpoint(value.alternate, seen)
            );
          }
          if (isIdentifierReference(value)) {
            if (isImportBinding(value)) {
              return true;
            }
            const variable = resolveVariable(context, value);
            const init = variable === null ? null : stableInitializer(variable);
            return init !== null && isSafeEndpoint(init, seen);
          }
          if (value.type !== "CallExpression") {
            return false;
          }
          const callee = unwrapExpression(value.callee);
          if (!isIdentifierReference(callee)) {
            return false;
          }
          if (isSafeHandlerFactory(callee.name)) {
            return true;
          }
          return (
            isImportBinding(callee) &&
            !callArguments(value).some(
              (argument) =>
                isThinEndpointCall(argument) || isHandBuiltDefinition(argument),
            )
          );
        };

        const checkMethods = (methods: unknown, at: unknown): void => {
          const map = readObject(methods);
          if (map === null) {
            if (isAstNode(at)) {
              context.report({ node: at, messageId: "unreadableTable" });
            }
            return;
          }
          for (const property of objectProperties(map)) {
            if (!isAstNode(property)) {
              continue;
            }
            if (property.type !== "Property") {
              context.report({ node: property, messageId: "unreadableTable" });
              continue;
            }
            const method = getPropertyName(property.key);
            if (method === null || !HTTP_METHODS.has(method)) {
              continue;
            }
            if (!isSafeEndpoint(property.value, new Set())) {
              context.report({
                node: property,
                messageId: "requireSafeHandler",
                data: { method },
              });
            }
          }
        };

        return {
          CallExpression(node) {
            if (getCalleeName(node.callee) !== "routes") {
              return;
            }
            const tableArgument = node.arguments.at(0);
            const table = readObject(tableArgument);
            if (table === null) {
              context.report({
                node: isAstNode(tableArgument) ? tableArgument : node,
                messageId: "unreadableTable",
              });
              return;
            }
            for (const entry of objectProperties(table)) {
              if (!isAstNode(entry)) {
                continue;
              }
              if (entry.type !== "Property") {
                context.report({ node: entry, messageId: "unreadableTable" });
                continue;
              }
              checkMethods(entry.value, entry);
            }
          },
        };
      },
    },
  },
});
