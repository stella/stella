// A handler whose Elysia schema declares a file/blob field must declare its
// transport disposition.
//
// The generic capability transport (`invoke_capability` and the generated CLI)
// carries JSON. A `t.File()` / `t.Files()` / `t.Blob()` field cannot cross it:
// a plain string passes `format: "binary"` validation and reaches a handler
// that expects a `File`. What the catalog says about such a capability — which
// field carries the bytes, whether that field is optional (so the JSON modes
// still run), and where the same work can be done instead — comes from one
// place: the `transport` field on the handler config
// (`apps/api/src/lib/capability-transport.ts`). Omitting it declares
// `{ type: "json" }`, which for a file-shaped handler is simply false.
//
// This rule is the author-time half of the guard: it flags the config in the
// same module as the file schema, immediately, in the editor. The complete
// guard is the capability exporter, which re-derives both legs from the LIVE
// schema and the handler source and fails on any disagreement — including the
// cases this rule cannot see, such as a body schema imported from a sibling
// module. Neither replaces the other: the lint rule is fast and local, the
// exporter is total.
//
// Flagged:
//   const bodySchema = t.Object({ file: t.File() });
//   const config = { permissions, mcp, body: bodySchema } satisfies HandlerConfig;
//
// Allowed:
//   const config = {
//     permissions,
//     mcp,
//     transport: { type: "file-input", input: { ... }, alternative: { ... } },
//     body: bodySchema,
//   } satisfies HandlerConfig;
//
//   // an `internal` disposition never enters the catalog, so it has no
//   // transport to describe
//   const config = { permissions, mcp: { type: "internal", reason },
//     body: bodySchema } satisfies HandlerConfig;

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getCalleeName,
  getPropertyName,
  isAstNode,
  unwrapExpression,
} from "./utils.ts";

/** Elysia schema constructors that put raw bytes in a request field. */
const BINARY_SCHEMA_FACTORIES = new Set(["t.File", "t.Files", "t.Blob"]);

/** The config types whose objects carry an `mcp` disposition and a transport. */
const HANDLER_CONFIG_TYPES = new Set(["HandlerConfig", "SessionHandlerConfig"]);

const satisfiesHandlerConfig = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "TSSatisfiesExpression") {
    return false;
  }
  const annotation = node["typeAnnotation"];
  if (!isAstNode(annotation) || annotation.type !== "TSTypeReference") {
    return false;
  }
  const typeName = annotation["typeName"];
  return (
    isAstNode(typeName) &&
    typeName.type === "Identifier" &&
    typeof typeName["name"] === "string" &&
    HANDLER_CONFIG_TYPES.has(typeName["name"])
  );
};

const propertyValue = (objectExpression: unknown, name: string): unknown => {
  if (
    !isAstNode(objectExpression) ||
    !Array.isArray(objectExpression["properties"])
  ) {
    return undefined;
  }
  for (const property of objectExpression["properties"]) {
    if (
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property["key"]) === name
    ) {
      return property["value"];
    }
  }
  return undefined;
};

const hasProperty = (objectExpression: unknown, name: string): boolean =>
  propertyValue(objectExpression, name) !== undefined;

/**
 * An `internal` MCP disposition is a permanent reviewed waiver: the handler
 * never enters the capability catalog, so no client ever describes its
 * transport and there is nothing to state. Flipping it to a capability
 * disposition is what makes the declaration required, and the exporter fails on
 * that flip.
 */
const isInternalDisposition = (configObject: unknown): boolean => {
  const mcp = unwrapExpression(propertyValue(configObject, "mcp"));
  if (mcp?.type !== "ObjectExpression") {
    return false;
  }
  const type = unwrapExpression(propertyValue(mcp, "type"));
  return (
    isAstNode(type) && type.type === "Literal" && type["value"] === "internal"
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-file-transport-disposition" },
  rules: {
    "require-file-transport-disposition": {
      meta: {
        type: "problem",
        messages: {
          missingTransport:
            "This module declares a `{{factory}}` field, so its handler config " +
            "must declare a `transport` disposition naming the field, whether " +
            "it is required, the media types it accepts, and the alternative " +
            "transport (see CapabilityTransport in " +
            "apps/api/src/lib/capability-transport.ts). Without it the config " +
            "declares a plain JSON transport, and every client would advertise " +
            "a capability the generic path cannot run.",
        },
      },
      createOnce(context) {
        // Per-file state: the binary factory seen (if any) and the config
        // objects to report against once the whole module has been walked.
        let binaryFactory: string | null = null;
        let configNodes: unknown[] = [];

        return {
          before() {
            binaryFactory = null;
            configNodes = [];
            return true;
          },
          CallExpression(node) {
            if (binaryFactory !== null || !isAstNode(node)) {
              return;
            }
            const calleeName = getCalleeName(node["callee"]);
            if (
              calleeName !== null &&
              BINARY_SCHEMA_FACTORIES.has(calleeName)
            ) {
              binaryFactory = calleeName;
            }
          },
          TSSatisfiesExpression(node) {
            if (!satisfiesHandlerConfig(node) || !isAstNode(node)) {
              return;
            }
            const expression = unwrapExpression(node["expression"]);
            if (
              expression?.type === "ObjectExpression" &&
              !hasProperty(expression, "transport") &&
              !isInternalDisposition(expression)
            ) {
              configNodes.push(expression);
            }
          },
          "Program:exit"() {
            if (binaryFactory === null) {
              return;
            }
            for (const configNode of configNodes) {
              if (isAstNode(configNode)) {
                context.report({
                  node: configNode,
                  messageId: "missingTransport",
                  data: { factory: binaryFactory },
                });
              }
            }
          },
        };
      },
    },
  },
});
