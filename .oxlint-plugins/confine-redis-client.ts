// Confine the Valkey/Redis connection module to the coordination facades.
//
// Valkey holds only ephemeral coordination (queue transport, pub/sub, TTL'd
// counters, short locks), and every consumer owes a written degraded path for
// the outage case. Both properties are reviewable only while the set of
// modules that can open a connection stays small and named, so the allowlist
// lives in `oxlint.config.ts` with a reason per entry.
//
// This is a dedicated rule rather than a `no-restricted-imports` path because
// an oxlint override REPLACES a rule's whole config instead of merging it: an
// `apps/api/src/**` entry would silently drop the handler-scoped DB import
// restrictions that a later override installs for the same files.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode, isStringLiteral } from "./utils.ts";

const CONNECTION_MODULE = "@/api/lib/redis-client";
const CONNECTION_MODULE_SUFFIX = "/lib/redis-client";

const isConnectionModule = (source: unknown): boolean =>
  typeof source === "string" &&
  (source === CONNECTION_MODULE ||
    source.endsWith(CONNECTION_MODULE_SUFFIX) ||
    source.endsWith(`${CONNECTION_MODULE_SUFFIX}.ts`));

const configuredAllowedFiles = (context: {
  options?: readonly unknown[];
}): readonly string[] => {
  const options = context.options?.[0];
  if (typeof options !== "object" || options === null) {
    return [];
  }
  const allowedFiles = Reflect.get(options, "allowedFiles");
  return Array.isArray(allowedFiles)
    ? allowedFiles.filter((entry) => typeof entry === "string")
    : [];
};

export default eslintCompatPlugin({
  meta: { name: "confine-redis-client" },
  rules: {
    "confine-redis-client": {
      meta: {
        type: "problem",
        messages: {
          unconfinedImport:
            "Only the allowlisted coordination facades may import the Valkey connection module. " +
            "Go through the facade that owns this concern, or add this file to the allowlist in oxlint.config.ts with a reason. " +
            "Valkey may hold only ephemeral coordination, and every consumer needs a degraded path for an outage.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return !configuredAllowedFiles(context).some((allowed) =>
              filename.endsWith(allowed),
            );
          },
          ImportDeclaration(node) {
            if (!isConnectionModule(node.source?.value)) {
              return;
            }
            context.report({ node, messageId: "unconfinedImport" });
          },
          ImportExpression(node) {
            if (!isAstNode(node.source) || !isStringLiteral(node.source)) {
              return;
            }
            if (!isConnectionModule(node.source.value)) {
              return;
            }
            context.report({ node, messageId: "unconfinedImport" });
          },
        };
      },
    },
  },
});
