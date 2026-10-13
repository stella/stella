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
  apiTypecheckProjects: [
    "apps/api/.cache/typecheck-declarations/roots.json",
    "apps/api/.cache/typecheck-declarations/src.json",
    "apps/api/.cache/typecheck-declarations/tests.json",
  ],
} as const;
export const CI_GENERATED_FILES = Object.values(CI_GENERATED_OUTPUTS).flat();

export const CI_GENERATION_COMMANDS = [
  ["bun", "--cwd=apps/api", "run", "generate:capability-runtime"],
  ["bun", "--cwd=packages/cli", "run", "codegen:runtime"],
  ["bun", "--cwd=apps/web", "run", "typegen"],
  ["bun", "--cwd=apps/web", "run", "generate:route-tree"],
  [
    "bun",
    "node_modules/turbo/bin/turbo",
    "run",
    "generate:api-types",
    "--filter=@stll/web",
  ],
  [
    "bun",
    "node_modules/turbo/bin/turbo",
    "run",
    "generate:typecheck-declarations",
    "--filter=@stll/api",
  ],
] as const;

export const CAPABILITY_RUNTIME_INPUTS = [
  "apps/api/scripts/generate-capability-runtime.ts",
  "apps/api/scripts/lib/**",
  "apps/api/src/handlers/**/*.ts",
  "apps/api/src/lib/capability-transport*",
  "packages/cli/capabilities/*.json",
  "packages/cli/src/capability-catalog-data.ts",
  "packages/scripts/src/*.ts",
  "packages/api-contract/src/**",
  "packages/collation/src/**",
  "packages/sha256/src/**",
  "packages/runtime-mode/src/**",
  "bun.lock",
  "package.json",
] as const;
