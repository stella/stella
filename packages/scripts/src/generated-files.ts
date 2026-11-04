export const MCP_APP_GENERATED_OUTPUTS = {
  contracts: [
    "packages/mcp-apps/src/shared/generated/schemas.json",
    "packages/mcp-apps/src/shared/generated/contracts.js",
    "packages/mcp-apps/src/shared/generated/contracts.d.ts",
    "packages/mcp-apps/src/shared/generated/input-schemas.json",
    "packages/mcp-apps/src/shared/generated/input-projections.json",
  ],
  bundles: [
    "packages/mcp-apps/src/shared/generated/messages.json",
    "packages/mcp-apps/src/shared/generated/reader-messages.json",
    "packages/mcp-apps/src/shared/generated/reader-inputs.json",
    "packages/mcp-apps/src/shared/generated/style.css",
    "packages/mcp-apps/src/generated/runtime.js.txt",
    "packages/mcp-apps/src/generated/runtime.css.txt",
    "packages/mcp-apps/src/generated/bundles.ts",
  ],
} as const;

/** What the build writes to `packages/mcp-apps/src/<app>/generated/`. */
export const MCP_APP_DIRECTORY_OUTPUTS = [
  "app.html.txt",
  "app.js.txt",
  "app.css.txt",
] as const;

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
  prepaintLocale: ["apps/web/public/prepaint-init.js"],
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

// Postinstall may refresh only ignored outputs. Tracked generated files remain
// verification failures so installs never hide a change that belongs in Git.
export const INSTALL_OWNED_IGNORED_GENERATED_OUTPUTS = [
  {
    command: [
      "bun",
      "packages/scripts/src/api-typecheck-partition.ts",
      "--write",
    ],
    outputs: CI_GENERATED_OUTPUTS.apiTypecheckProjects,
  },
] as const;

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

/**
 * Every file the generated model snapshots read. The rates and capabilities
 * generators declare it as their inputs and CI plans the snapshot drift check
 * from it, so both stay one list.
 */
export const MODEL_CATALOG_INPUTS = [
  ".github/workflows/ci.yml",
  "packages/ai-catalog/package.json",
  "packages/ai-catalog/src/capabilities-overrides.ts",
  "packages/ai-catalog/src/capabilities.gen.ts",
  "packages/ai-catalog/src/document-input-overrides.ts",
  "packages/ai-catalog/src/index.ts",
  "packages/ai-catalog/src/model-defaults-ledger.ts",
  "packages/ai-catalog/src/model-rate-policy.ts",
  "packages/ai-catalog/src/model-rate.ts",
  "packages/ai-catalog/src/model-rates.gen.ts",
  "packages/ai-catalog/src/reasoning-capabilities.ts",
  "packages/fetch/src/body-reader.ts",
  "packages/fetch/src/connection-failure.ts",
  "packages/fetch/src/index.ts",
  "packages/fetch/src/race-abort.ts",
  "packages/scripts/src/model-catalog-capabilities-gen.ts",
  "packages/scripts/src/model-catalog-capabilities.ts",
  "packages/scripts/src/model-catalog-rates-gen.ts",
  "packages/scripts/src/model-catalog-snapshot.ts",
  "packages/scripts/src/offline-check-startup.ts",
] as const;
