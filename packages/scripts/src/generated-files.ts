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
  ["bun", "--cwd=packages/cli", "run", "codegen:runtime"],
  ["bun", "apps/api/scripts/generate-capability-runtime.ts"],
  ["bun", "scripts/prepare-mcp-apps.ts"],
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

// Everything the in-memory catalog's handler graph can read keys the cache.
export const CAPABILITY_RUNTIME_INPUTS = [
  "apps/api/scripts/**",
  "apps/api/src/**",
  "apps/api/package.json",
  "packages/*/src/**",
  "packages/*/package.json",
  "packages/api-contract/assets/**",
  "packages/catalogue/entries/**",
  "packages/skills/blueprints/**",
  "packages/skills/skills/**",
  "packages/transactional/components/**",
  "packages/transactional/emails/**",
  "packages/transactional/i18n/**",
  "packages/transactional/render/**",
  "bunfig.toml",
  "bun.lock",
  "package.json",
  "patches/**",
] as const;
