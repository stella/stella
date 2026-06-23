// Keep the Tools route as a lightweight shell.
//
// The catalogue browser owns heavy UI and route-local query subscriptions. The
// Tools route may import its types, but value imports must stay behind
// React.lazy so the route shell commits before the catalogue chunk mounts.

const CATALOGUE_BROWSER_MODULE =
  "@/routes/_protected.knowledge/-components/catalogue/catalogue-browser";

const isCatalogueBrowserModule = (source) =>
  source === CATALOGUE_BROWSER_MODULE ||
  source.endsWith("/catalogue/catalogue-browser");

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const configuredRouteFiles = (context) => {
  const options = context.options?.[0] ?? {};
  return Array.isArray(options.routeFiles) ? options.routeFiles : [];
};

const isGuardedRouteFile = (context) => {
  const filename = filenameForContext(context).replaceAll("\\", "/");
  return configuredRouteFiles(context).some((routeFile) =>
    filename.endsWith(routeFile),
  );
};

const isTypeOnlyImport = (node) => {
  if (node.importKind === "type") {
    return true;
  }

  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) {
    return false;
  }

  return node.specifiers.every((specifier) => specifier.importKind === "type");
};

export default {
  meta: { name: "no-static-catalogue-route-import" },
  rules: {
    "no-static-catalogue-route-import": {
      meta: {
        type: "problem",
        messages: {
          staticCatalogueImport:
            "Keep the catalogue browser behind React.lazy in this route. Use import type for erased types; value imports must stay inside the lazy import callback.",
        },
        schema: [
          {
            type: "object",
            properties: {
              routeFiles: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        if (!isGuardedRouteFile(context)) {
          return {};
        }

        return {
          ImportDeclaration(node) {
            const source = node.source?.value;
            if (
              typeof source !== "string" ||
              !isCatalogueBrowserModule(source)
            ) {
              return;
            }

            if (isTypeOnlyImport(node)) {
              return;
            }

            context.report({ node, messageId: "staticCatalogueImport" });
          },
        };
      },
    },
  },
};
