export const MCP_APP_GENERATED_OUTPUTS = {
  contracts: [
    "packages/mcp-apps/src/shared/generated/schemas.json",
    "packages/mcp-apps/src/shared/generated/contracts.js",
    "packages/mcp-apps/src/shared/generated/contracts.d.ts",
  ],
  bundles: [
    "packages/mcp-apps/src/shared/generated/messages.json",
    "packages/mcp-apps/src/shared/generated/reader-messages.json",
    "packages/mcp-apps/src/shared/generated/reader-inputs.json",
    "packages/mcp-apps/src/shared/generated/style.css",
    "packages/mcp-apps/src/generated/bundles.ts",
  ],
} as const;

export const CI_GENERATED_OUTPUTS = {
  capabilityRuntime: [
    "apps/api/src/mcp/generated/capability-dispatch.ts",
    "apps/api/src/mcp/generated/capability-catalog.ts",
    "apps/api/src/mcp/generated/capability-feature-bindings.ts",
  ],
  cliRegistry: ["apps/api/mcp-connect-tool-weights.json"],
  cliRuntime: [
    "packages/cli/src/generated/route-map.ts",
    "packages/cli/src/generated/tool-annotations.ts",
  ],
  webMessages: ["apps/web/src/i18n/langs/messages.gen.ts"],
  routeTree: [
    "apps/web/src/routeTree.gen.ts",
    "apps/web/src/route-templates.gen.ts",
  ],
  apiTypes: ["apps/web/src/generated/api-routes.gen.ts"],
  apiTypecheckProjects: [
    "apps/api/.cache/typecheck-declarations/roots.json",
    "apps/api/.cache/typecheck-declarations/src.json",
    "apps/api/.cache/typecheck-declarations/tests.json",
  ],
} as const;
export const CI_GENERATED_FILES = Object.values(CI_GENERATED_OUTPUTS).flat();

export const CI_GENERATION_COMMANDS = [
  ["bun", "apps/api/scripts/generate-capability-runtime.ts"],
  ["bun", "scripts/prepare-mcp-apps.ts"],
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
  "packages/cli/capabilities/**",
  "packages/cli/src/capability-catalog-data.ts",
  "packages/scripts/src/*.ts",
  "packages/api-contract/src/**",
  "packages/collation/src/**",
  "packages/sha256/src/**",
  "packages/runtime-mode/src/**",
  "bun.lock",
  "package.json",
  "patches/**",
] as const;
