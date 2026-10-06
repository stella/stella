import { eslintCompatPlugin } from "@oxlint/plugins";

import { CALLER_FEATURE } from "../apps/web/src/lib/organization/feature-access/surfaces.ts";
import type { AstNode } from "./utils.ts";
import {
  canonicalModuleId,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isTestFile,
  memberPropertyName,
  repoRelativeFilename,
} from "./utils.ts";

const OWNER = "@/lib/organization/feature-access/access";
const IMPORTER_ROOT = "apps/web/src/route.tsx";
const GATED_ROUTE_IMPORTS = Object.values(CALLER_FEATURE).flatMap((feature) =>
  feature.routeImports.map((source) =>
    canonicalModuleId(source, IMPORTER_ROOT),
  ),
);
const isGatedModule = (moduleId: string): boolean =>
  GATED_ROUTE_IMPORTS.some(
    (prefix) =>
      moduleId === prefix ||
      moduleId.startsWith(`${prefix}/`) ||
      (prefix.endsWith("/") && moduleId.startsWith(prefix)),
  );
const isWithin = (node: AstNode, ancestor: AstNode): boolean => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
};
const loaderFor = (options: unknown): AstNode | null => {
  if (
    !isAstNode(options) ||
    options.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return null;
  }
  for (const property of options.properties) {
    if (
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property.key) === "loader" &&
      isAstNode(property.value)
    ) {
      return property.value;
    }
  }
  return null;
};
const withinAdmissionCallback = (
  call: AstNode,
  admission: AstNode,
): boolean => {
  if (!Array.isArray(admission.arguments)) {
    return false;
  }
  const options = admission.arguments.at(0);
  let current: unknown = call.parent;
  while (isAstNode(current)) {
    if (
      current.type === "Property" &&
      getPropertyName(current.key) === "load" &&
      current.parent === options
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

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
      createOnce(context) {
        let enabled = false;
        let filename = "";
        const routes: { node: AstNode; loader: AstNode | null }[] = [];
        const admissions: AstNode[] = [];
        const featureCalls: AstNode[] = [];
        const featureBindings = new Set<string>();
        let gatedImport: AstNode | null = null;
        const loaders = new Set<string>();
        const routeFactories = new Set<string>();
        return {
          before() {
            routes.length = 0;
            admissions.length = 0;
            featureCalls.length = 0;
            featureBindings.clear();
            gatedImport = null;
            loaders.clear();
            routeFactories.clear();
            const reportedFilename = repoRelativeFilename(context);
            const webRoot = reportedFilename.indexOf("apps/web/src/");
            filename =
              webRoot === -1 ? IMPORTER_ROOT : reportedFilename.slice(webRoot);
            enabled =
              !isTestFile(reportedFilename) &&
              (reportedFilename.includes("apps/web/src/") ||
                reportedFilename.endsWith(
                  "require-caller-feature-access.fixture.tsx",
                ));
          },
          ImportDeclaration(node) {
            if (!enabled || !isAstNode(node) || node.importKind === "type") {
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
            const moduleId = canonicalModuleId(source, filename);
            const gated = isGatedModule(moduleId);
            if (!Array.isArray(node.specifiers)) {
              return;
            }
            const runtimeSpecifiers = node.specifiers.filter(
              (specifier) =>
                isAstNode(specifier) && specifier.importKind !== "type",
            );
            if (
              gated &&
              (node.specifiers.length === 0 || runtimeSpecifiers.length > 0)
            ) {
              gatedImport = node;
            }
            for (const specifier of runtimeSpecifiers) {
              if (!isAstNode(specifier) || specifier.importKind === "type") {
                continue;
              }
              const { local: binding } = specifier;
              if (!isIdentifier(binding)) {
                continue;
              }
              if (gated) {
                featureBindings.add(binding.name);
              }
              const name = getPropertyName(specifier.imported);
              if (
                moduleId === canonicalModuleId(OWNER, IMPORTER_ROOT) &&
                name === "loadCallerFeature"
              ) {
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
              isGatedModule(canonicalModuleId(source, filename))
            ) {
              gatedImport = node;
            }
          },
          CallExpression(node) {
            if (!enabled || !isAstNode(node)) {
              return;
            }
            const callee = node.callee;
            if (
              isAstNode(callee) &&
              callee.type === "CallExpression" &&
              isIdentifier(callee.callee) &&
              routeFactories.has(callee.callee.name)
            ) {
              const options = Array.isArray(node.arguments)
                ? node.arguments.at(0)
                : undefined;
              routes.push({ node, loader: loaderFor(options) });
            }
            if (
              (isIdentifier(callee) && featureBindings.has(callee.name)) ||
              (isAstNode(callee) &&
                callee.type === "MemberExpression" &&
                isIdentifier(callee.object) &&
                featureBindings.has(callee.object.name))
            ) {
              featureCalls.push(node);
            }
            if (
              isIdentifier(callee) &&
              loaders.has(callee.name) &&
              isAstNode(node.parent) &&
              (node.parent.type === "AwaitExpression" ||
                node.parent.type === "ReturnStatement")
            ) {
              admissions.push(node);
            }
          },
          MemberExpression(node) {
            if (!enabled || !isAstNode(node)) {
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
            if (!enabled || gatedImport === null) {
              return;
            }
            for (const route of routes) {
              const loader = route.loader;
              const ownedAdmissions =
                loader === null
                  ? []
                  : admissions.filter((call) => isWithin(call, loader));
              const unadmittedCalls =
                loader === null
                  ? []
                  : featureCalls.filter(
                      (call) =>
                        isWithin(call, loader) &&
                        !ownedAdmissions.some((admission) =>
                          withinAdmissionCallback(call, admission),
                        ),
                    );
              if (ownedAdmissions.length === 0 || unadmittedCalls.length > 0) {
                context.report({ node: gatedImport, messageId: "route" });
              }
            }
          },
        };
      },
    },
  },
});
