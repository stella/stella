// Read deployment feature flags through their owner.
//
// `isDeploymentFeatureEnabled` (`apps/api/src/lib/deployment-feature.ts`)
// decides, per flag, whether local development opens the feature. A raw
// `env.FEATURE_*` read skips that decision, so a route gate, an agent tool and
// an in-handler default can disagree about one flag. This rule reports, in the
// files it is enabled for:
//
//   - a member read of a `FEATURE_*` key on the API env object, whether named
//     `env` or imported from `@/api/env` under another local name
//     (`env.FEATURE_X`, `env?.FEATURE_X`, `env["FEATURE_X"]`, `config.FEATURE_X`);
//   - a destructuring of a `FEATURE_*` key from that object
//     (`const { FEATURE_X } = env`).
//
// Test files are exempt. An intentional raw read is an `allowedReads` entry
// (`{ file, flags }`, with its reason as a config comment), never a
// suppression. A dynamic key or a different env object (a worker's own
// schema) is out of scope; the owner itself reads through a dynamic key.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isImportedFrom,
  isTestFile,
  memberPropertyName,
  repoRelativeFilename,
} from "./utils.ts";

const ENV_IDENTIFIER = "env";
const ENV_MODULES = ["apps/api/src/env"];
const ENV_EXPORTS: ReadonlySet<string> = new Set([ENV_IDENTIFIER]);
const FEATURE_PREFIX = "FEATURE_";

type AllowedRead = { file: string; flags: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readAllowedReads = (options: unknown): AllowedRead[] => {
  if (!isRecord(options) || !Array.isArray(options.allowedReads)) {
    return [];
  }
  return options.allowedReads.flatMap((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      !Array.isArray(entry.flags)
    ) {
      return [];
    }
    const flags = entry.flags.filter(
      (flag: unknown): flag is string => typeof flag === "string",
    );
    return [{ file: entry.file, flags }];
  });
};

const featureKey = (name: string | null): string | null =>
  name?.startsWith(FEATURE_PREFIX) === true ? name : null;

type RuleContext = Parameters<typeof isImportedFrom>[0]["context"];

// The API env object: the import resolved through any local alias, or a
// binding literally named `env`.
const isEnvObject = (context: RuleContext, node: unknown): boolean =>
  isIdentifier(node, ENV_IDENTIFIER) ||
  (isAstNode(node) &&
    node.type === "Identifier" &&
    isImportedFrom({
      context,
      node,
      modules: ENV_MODULES,
      names: ENV_EXPORTS,
    }));

const featureMemberRead = (
  context: RuleContext,
  node: AstNode,
): string | null =>
  isEnvObject(context, node.object)
    ? featureKey(memberPropertyName(node))
    : null;

const destructuredFeatureKeys = (
  context: RuleContext,
  node: AstNode,
): string[] => {
  if (
    !isEnvObject(context, node.init) ||
    !isAstNode(node.id) ||
    node.id.type !== "ObjectPattern" ||
    !Array.isArray(node.id.properties)
  ) {
    return [];
  }
  return node.id.properties.flatMap((property: unknown) => {
    if (!isAstNode(property) || property.type !== "Property") {
      return [];
    }
    const key = featureKey(getPropertyName(property.key));
    return key === null ? [] : [key];
  });
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-deployment-feature-read" },
  rules: {
    "no-raw-deployment-feature-read": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              allowedReads: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    flags: { type: "array", items: { type: "string" } },
                  },
                  required: ["file", "flags"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          rawRead:
            "Read `{{flag}}` through `isDeploymentFeatureEnabled` (apps/api/src/lib/deployment-feature.ts) so every surface shares its local-development policy; an intentional raw read is an `allowedReads` entry with a reason.",
        },
      },
      createOnce(context) {
        let allowedFlags: ReadonlySet<string> = new Set();
        const report = (node: AstNode, flag: string) => {
          if (!allowedFlags.has(flag)) {
            context.report({ node, messageId: "rawRead", data: { flag } });
          }
        };
        return {
          before() {
            const filename = repoRelativeFilename(context);
            const entries = readAllowedReads(context.options.at(0));
            allowedFlags = new Set(
              entries
                .filter((entry) => filename.endsWith(entry.file))
                .flatMap((entry) => entry.flags),
            );
            return !isTestFile(filename);
          },
          MemberExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            const flag = featureMemberRead(context, node);
            if (flag !== null) {
              report(node, flag);
            }
          },
          VariableDeclarator(node) {
            if (!isAstNode(node)) {
              return;
            }
            for (const flag of destructuredFeatureKeys(context, node)) {
              report(node, flag);
            }
          },
        };
      },
    },
  },
});
