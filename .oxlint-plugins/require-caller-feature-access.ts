import { eslintCompatPlugin } from "@oxlint/plugins";

import { CALLER_FEATURE } from "../apps/web/src/lib/organization/feature-access/surfaces.ts";
import type { AstNode } from "./utils.ts";
import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isTestFile,
  memberPropertyName,
  repoRelativeFilename,
} from "./utils.ts";

const OWNER = "@/lib/organization/feature-access/access";
const GATED_ROUTE_IMPORTS = Object.values(CALLER_FEATURE).flatMap((feature) => [
  ...feature.routeImports,
]);

export default eslintCompatPlugin({
  meta: { name: "require-caller-feature-access" },
  rules: {
    "require-caller-feature-access": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          route:
            "A route importing a caller-gated feature must admit it through loadCallerFeature in its loader before prefetching.",
          local:
            "Caller-gated features use the server decision through the feature-access owner, without browser flags or preview state.",
        },
      },
      create(context) {
        let enabled = false;
        let routeDefinition = false;
        let gatedImport: AstNode | null = null;
        let guarded = false;
        const loaders = new Set<string>();
        const routeFactories = new Set<string>();
        return {
          Program() {
            const filename = repoRelativeFilename(context);
            enabled =
              !isTestFile(filename) &&
              (filename.includes("apps/web/src/") ||
                filename.endsWith("require-caller-feature-access.fixture.tsx"));
            return enabled;
          },
          ImportDeclaration(node) {
            if (!enabled || !isAstNode(node)) {
              return;
            }
            const sourceNode = node.source;
            if (
              !isAstNode(sourceNode) ||
              typeof sourceNode.value !== "string"
            ) {
              return;
            }
            const source = sourceNode.value;
            if (source === "@/hooks/use-avt-preview") {
              context.report({ node, messageId: "local" });
            }
            if (
              GATED_ROUTE_IMPORTS.some((prefix) => source.startsWith(prefix))
            ) {
              gatedImport = node;
            }
            if (!Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                !isAstNode(specifier) ||
                specifier.type !== "ImportSpecifier"
              ) {
                continue;
              }
              const { local: binding } = specifier;
              if (!isIdentifier(binding)) {
                continue;
              }
              const name = getPropertyName(specifier.imported);
              if (source === OWNER && name === "loadCallerFeature") {
                loaders.add(binding.name);
              }
              if (
                source === "@tanstack/react-router" &&
                name === "createFileRoute"
              ) {
                routeFactories.add(binding.name);
              }
            }
          },
          ImportExpression(node) {
            if (!enabled || !isAstNode(node) || !isAstNode(node.source)) {
              return;
            }
            const source = node.source.value;
            if (
              typeof source === "string" &&
              GATED_ROUTE_IMPORTS.some((prefix) => source.startsWith(prefix))
            ) {
              gatedImport = node;
            }
          },
          CallExpression(node) {
            if (!enabled || !isIdentifier(node.callee)) {
              return;
            }
            if (routeFactories.has(node.callee.name)) {
              routeDefinition = true;
            }
            if (
              !loaders.has(node.callee.name) ||
              !isAstNode(node.parent) ||
              (node.parent.type !== "AwaitExpression" &&
                node.parent.type !== "ReturnStatement")
            ) {
              return;
            }
            let ancestor: unknown = node.parent;
            while (isAstNode(ancestor)) {
              if (
                ancestor.type === "Property" &&
                getPropertyName(ancestor.key) === "loader"
              ) {
                guarded = true;
                break;
              }
              ancestor = ancestor.parent;
            }
          },
          MemberExpression(node) {
            if (!enabled) {
              return;
            }
            const key = memberPropertyName(node);
            if (
              key === "VITE_FEATURE_LEGAL_LISTS" ||
              key === "avtPreview" ||
              key === "setAvtPreview"
            ) {
              context.report({ node, messageId: "local" });
            }
          },
          VariableDeclarator(node) {
            if (!enabled || node.id.type !== "ObjectPattern") {
              return;
            }
            for (const property of node.id.properties) {
              if (property.type !== "Property") {
                continue;
              }
              const key = getPropertyName(property.key);
              if (
                key === "VITE_FEATURE_LEGAL_LISTS" ||
                key === "avtPreview" ||
                key === "setAvtPreview"
              ) {
                context.report({ node: property, messageId: "local" });
              }
            }
          },
          "Program:exit"() {
            if (enabled && routeDefinition && gatedImport && !guarded) {
              context.report({ node: gatedImport, messageId: "route" });
            }
          },
        };
      },
    },
  },
});
