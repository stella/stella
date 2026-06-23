// Devtools packages can schedule browser work while React routes are still
// mounting. Keep them in explicit lazy-loaded islands so normal dev pages do
// not import the packages unless the devtools toggle is enabled.

const DEVTOOLS_PACKAGES = new Set([
  "@tanstack/react-devtools",
  "@tanstack/react-query-devtools",
  "@tanstack/react-router-devtools",
  "@tanstack/react-table-devtools",
]);

const ALLOWED_PACKAGE_FILES = new Map([
  [
    "@tanstack/react-devtools",
    ["apps/web/src/components/tanstack-devtools-root.tsx"],
  ],
  [
    "@tanstack/react-query-devtools",
    ["apps/web/src/components/tanstack-devtools-root.tsx"],
  ],
  [
    "@tanstack/react-router-devtools",
    ["apps/web/src/components/tanstack-devtools-root.tsx"],
  ],
  [
    "@tanstack/react-table-devtools",
    [
      "apps/web/src/components/tanstack-devtools-root.tsx",
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools.tsx",
    ],
  ],
]);

const DYNAMIC_ONLY_MODULES = [
  "@/components/tanstack-devtools-root",
  "@/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools",
];

const filenameForContext = (context) =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

const isAllowedPackageFile = (context, source) => {
  const filename = filenameForContext(context);
  const allowedFiles = ALLOWED_PACKAGE_FILES.get(source) ?? [];
  return allowedFiles.some((allowedFile) => filename.endsWith(allowedFile));
};

const isDynamicOnlyModule = (source) =>
  DYNAMIC_ONLY_MODULES.some(
    (moduleName) => source === moduleName || source.endsWith(moduleName),
  ) ||
  source === "./tanstack-devtools-root" ||
  source === "./table-devtools" ||
  source.endsWith("/tanstack-devtools-root") ||
  source.endsWith("/table/table-devtools") ||
  source.endsWith("/table-devtools");

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
  meta: { name: "no-static-devtools-import" },
  rules: {
    "no-static-devtools-import": {
      meta: {
        type: "problem",
        messages: {
          staticDevtoolsPackage:
            "Keep TanStack devtools package imports inside the approved lazy-loaded devtools modules.",
          staticDevtoolsModule:
            "Keep devtools modules behind a dynamic import so route shells can mount before devtools code loads.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const source = node.source?.value;
            if (typeof source !== "string" || isTypeOnlyImport(node)) {
              return;
            }

            if (DEVTOOLS_PACKAGES.has(source)) {
              if (isAllowedPackageFile(context, source)) {
                return;
              }

              context.report({ node, messageId: "staticDevtoolsPackage" });
              return;
            }

            if (isDynamicOnlyModule(source)) {
              context.report({ node, messageId: "staticDevtoolsModule" });
            }
          },
        };
      },
    },
  },
};
