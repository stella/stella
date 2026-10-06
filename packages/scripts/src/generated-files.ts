export const CI_GENERATED_OUTPUTS = {
  capabilityRuntime: [
    "apps/api/src/mcp/generated/capability-dispatch.ts",
    "apps/api/src/mcp/generated/capability-catalog.ts",
    "apps/api/src/mcp/generated/capability-feature-bindings.ts",
  ],
  cliRuntime: [
    "packages/cli/src/generated/route-map.ts",
    "packages/cli/src/generated/tool-annotations.ts",
  ],
  webMessages: ["apps/web/src/i18n/langs/messages.gen.ts"],
  prepaintLocale: ["apps/web/public/prepaint-init.js"],
  routeTree: ["apps/web/src/routeTree.gen.ts"],
  apiTypes: ["apps/web/src/generated/api-routes.gen.ts"],
} as const;
export const CI_GENERATED_FILES = Object.values(CI_GENERATED_OUTPUTS).flat();

export const CI_GENERATION_COMMANDS = [
  ["bun", "apps/api/scripts/generate-capability-runtime.ts"],
  ["bun", "--cwd=packages/cli", "run", "codegen:runtime"],
  ["bun", "--cwd=apps/web", "run", "typegen"],
  ["bun", "--cwd=apps/web", "run", "generate:route-tree"],
  ["bun", "--cwd=apps/web", "run", "generate:api-types"],
] as const;
