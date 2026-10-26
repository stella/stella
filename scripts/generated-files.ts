import {
  CAPABILITY_RUNTIME_INPUTS,
  CI_GENERATED_OUTPUTS,
  MCP_APP_GENERATED_OUTPUTS,
} from "../packages/scripts/src/generated-files";

export {
  CI_GENERATED_OUTPUTS,
  CI_GENERATED_FILES,
  CI_GENERATION_COMMANDS,
} from "../packages/scripts/src/generated-files";

type GeneratorCheck =
  | {
      check: readonly string[];
      checkedBy?: string;
      checkedWith?: never;
      unchecked?: never;
    }
  | {
      check: null;
      checkedBy: string;
      /**
       * The command the `checkedBy` step runs when it is neither `write` nor
       * its `--check` form.
       */
      checkedWith?: readonly string[];
      unchecked?: never;
    }
  | { check: null; checkedBy?: never; checkedWith?: never; unchecked: string };

export type Generator = {
  id: string;
  outputs: readonly string[];
  blocks?: readonly { path: string; begin: string; end: string }[];
  inputs: readonly string[];
  write: readonly string[];
  prepare?: readonly string[];
  /**
   * Whether the autofix workflow may run `write` and push its outputs. Only a
   * pure function of committed source qualifies: no network, secrets, clock,
   * randomness, or untracked machine state. `autofix-pure-generators.test.ts`
   * records what was checked for the ones enabled after the first pass.
   */
  autofix: boolean;
  after: readonly string[];
} & GeneratorCheck &
  ({ outputKind: "committed" } | { outputKind: "derived" });

const MODEL_CATALOG_INPUTS = [
  ".github/workflows/ci.yml",
  "packages/ai-catalog/package.json",
  "packages/ai-catalog/src/capabilities-overrides.ts",
  "packages/ai-catalog/src/capabilities.gen.ts",
  "packages/ai-catalog/src/document-input-overrides.ts",
  "packages/ai-catalog/src/index.ts",
  "packages/ai-catalog/src/model-rate-policy.ts",
  "packages/ai-catalog/src/model-rate.ts",
  "packages/ai-catalog/src/model-rates.gen.ts",
  "packages/scripts/src/model-catalog-capabilities-gen.ts",
  "packages/scripts/src/model-catalog-capabilities.ts",
  "packages/scripts/src/model-catalog-rates-gen.ts",
] as const;

const GENERATOR_DECLARATIONS = [
  {
    id: "tailwind-class-cache",
    outputKind: "committed",
    outputs: [".tailwind-cache/**"],
    inputs: [
      // Each Tailwind entry point in oxlint.config.ts: its stylesheets, linted
      // sources and package versions (chat and workspace-ui use the web
      // stylesheet).
      "apps/web/**/*.css",
      "apps/web/**/*.{ts,tsx,js,jsx}",
      "apps/web/package.json",
      "apps/desktop/**/*.css",
      "apps/desktop/**/*.{ts,tsx,js,jsx}",
      "apps/desktop/package.json",
      "apps/playground/**/*.css",
      "apps/playground/**/*.{ts,tsx,js,jsx}",
      "apps/playground/package.json",
      "apps/landing/**/*.css",
      "apps/landing/**/*.{ts,tsx,js,jsx}",
      "apps/landing/package.json",
      "packages/ui/**/*.css",
      "packages/ui/**/*.{ts,tsx,js,jsx}",
      "packages/ui/package.json",
      "packages/chat/**/*.{ts,tsx,js,jsx}",
      "packages/chat/package.json",
      "packages/workspace-ui/**/*.{ts,tsx,js,jsx}",
      "packages/workspace-ui/package.json",
      "oxlint.config.ts",
      "scripts/generate-tailwind-classes.ts",
      "patches/oxlint-tailwindcss@1.16.0.patch",
      "package.json",
      "bun.lock",
    ],
    write: ["bun", "scripts/generate-tailwind-classes.ts", "--write"],
    check: ["bun", "scripts/generate-tailwind-classes.ts", "--check"],
    autofix: true,
    after: [],
  },
  {
    id: "failure-tags",
    outputKind: "committed",
    outputs: ["apps/api/src/lib/observability/failure-tags.gen.ts"],
    inputs: [
      "apps/api/src/**/*.ts",
      "apps/api/src/**/*.tsx",
      "packages/*/src/**/*.ts",
      "packages/*/src/**/*.tsx",
      "scripts/failure-tags.ts",
      "scripts/generate-failure-tags.ts",
    ],
    write: ["bun", "scripts/generate-failure-tags.ts", "--write"],
    check: ["bun", "scripts/generate-failure-tags.ts"],
    autofix: false,
    after: [],
  },
  {
    id: "migration-lock-baseline",
    outputKind: "committed",
    outputs: ["scripts/migration-lock-baseline.ts"],
    inputs: [
      "scripts/check-migration-locks.ts",
      "scripts/check-migration-safety.ts",
      "scripts/migration-lock-census.ts",
      "scripts/online-ddl-lock-census.ts",
      "apps/api/src/db/online-ddl.ts",
      "apps/api/drizzle/**/*.sql",
    ],
    write: ["bun", "scripts/check-migration-locks.ts", "--write-baseline"],
    check: ["bun", "scripts/check-migration-locks.ts"],
    autofix: false,
    after: [],
  },
  {
    id: "cloud-setup",
    outputKind: "committed",
    outputs: [".agents/cloud-setup.sh"],
    inputs: [
      "stll-toolchain.json",
      ".node-version",
      "package.json",
      "bun.lock",
      "scripts/generate-cloud-setup.ts",
      "scripts/generated-artifacts.ts",
    ],
    write: ["bun", "scripts/generate-cloud-setup.ts", "--write"],
    check: ["bun", "scripts/generate-cloud-setup.ts"],
    autofix: true,
    after: [],
  },
  {
    id: "api-image-install-tooling",
    outputKind: "committed",
    outputs: ["apps/api/Dockerfile"],
    blocks: [
      {
        path: "apps/api/Dockerfile",
        begin: "# BEGIN GENERATED INSTALL TOOLING",
        end: "# END GENERATED INSTALL TOOLING",
      },
    ],
    // The closure has relative imports only, so it changes only through
    // these files; the check fails when the closure outgrows this list.
    inputs: [
      "apps/api/Dockerfile",
      "packages/scripts/src/child-exit-status.ts",
      "packages/sha256/src/bun.ts",
      "scripts/ci-install-store.ts",
      "scripts/ci-install.ts",
      "scripts/docker-source-closure.ts",
    ],
    write: [
      "bun",
      "scripts/docker-source-closure.ts",
      "--write-install-tooling",
    ],
    check: [
      "bun",
      "scripts/docker-source-closure.ts",
      "--check-install-tooling",
    ],
    autofix: true,
    after: [],
  },
  {
    id: "bun-toolchain",
    outputKind: "committed",
    outputs: ["scripts/bun-toolchain.gen.json"],
    inputs: [
      "package.json",
      "scripts/generate-bun-toolchain.ts",
      "scripts/generated-artifacts.ts",
      "packages/scripts/src/generated-artifact-format.ts",
    ],
    write: ["bun", "scripts/generate-bun-toolchain.ts", "--write"],
    check: ["bun", "scripts/generate-bun-toolchain.ts"],
    autofix: true,
    after: [],
  },
  {
    id: "case-law-publication-migration",
    outputKind: "committed",
    outputs: [
      "apps/api/drizzle/20261010212100_case_law_publication_filter/migration.sql",
    ],
    inputs: [
      "scripts/generate-case-law-publication-migration.ts",
      "apps/api/src/lib/case-law/published-decisions-sql.ts",
      "apps/api/src/lib/legal-search/partial-observation-sql.ts",
      "apps/api/drizzle/20260916110000_published_statute_citation_counts/migration.sql",
    ],
    write: ["bun", "scripts/generate-case-law-publication-migration.ts"],
    check: [
      "bun",
      "scripts/generate-case-law-publication-migration.ts",
      "--check",
    ],
    autofix: false,
    after: [],
  },
  {
    id: "status-tables",
    outputKind: "committed",
    outputs: ["apps/api/src/lib/db/status-tables.gen.ts"],
    inputs: [
      "apps/api/src/db/schema/**",
      "apps/api/src/db/auth-schema.ts",
      "apps/api/src/db/agent-auth-schema.ts",
      "apps/api/scripts/generate-status-tables.ts",
    ],
    write: ["bun", "apps/api/scripts/generate-status-tables.ts", "--write"],
    check: ["bun", "apps/api/scripts/generate-status-tables.ts"],
    autofix: true,
    after: [],
  },
  {
    id: "account-export-tables",
    outputKind: "committed",
    outputs: ["apps/api/src/lib/account-export/user-owned-tables.gen.ts"],
    inputs: [
      "apps/api/src/db/schema/**",
      "apps/api/src/db/auth-schema.ts",
      "apps/api/src/db/agent-auth-schema.ts",
      "apps/api/src/lib/account-export/schema-census.ts",
      "apps/api/scripts/generate-account-export-tables.ts",
    ],
    write: [
      "bun",
      "apps/api/scripts/generate-account-export-tables.ts",
      "--write",
    ],
    check: ["bun", "apps/api/scripts/generate-account-export-tables.ts"],
    autofix: true,
    after: [],
  },
  {
    id: "schema-index",
    outputKind: "committed",
    outputs: ["apps/api/src/db/schema-index/*.md"],
    inputs: [
      "apps/api/src/db/schema/**",
      "apps/api/src/db/auth-schema.ts",
      "apps/api/src/db/agent-auth-schema.ts",
      "apps/api/src/db/registration-budget-schema.ts",
      "apps/api/scripts/generate-schema-index.ts",
    ],
    write: ["bun", "apps/api/scripts/generate-schema-index.ts", "--write"],
    check: ["bun", "apps/api/scripts/generate-schema-index.ts"],
    autofix: true,
    after: [],
  },
  {
    id: "transition-triggers",
    outputKind: "committed",
    outputs: ["apps/api/drizzle/*_flow_run_transitions/migration.sql"],
    inputs: [
      "apps/api/src/lib/db/flow-run-transition-spec.ts",
      "apps/api/src/lib/db/transition-sql.ts",
      "apps/api/scripts/generate-transition-triggers.ts",
    ],
    write: [
      "bun",
      "apps/api/scripts/generate-transition-triggers.ts",
      "--write",
    ],
    check: ["bun", "apps/api/scripts/generate-transition-triggers.ts"],
    autofix: false,
    after: ["status-tables"],
  },
  {
    id: "capability-catalog",
    outputKind: "committed",
    outputs: ["packages/cli/capabilities/**", "docs/capability-coverage.md"],
    inputs: [
      "apps/api/src/**",
      "apps/api/src/handlers/**",
      "apps/api/src/mcp/**",
      "apps/api/src/lib/capability-transport*",
      "apps/api/scripts/export-capability-catalog.ts",
      "apps/api/scripts/lib/**",
      "packages/cli/src/**",
      "packages/**",
      "bunfig.toml",
    ],
    write: ["bun", "apps/api/scripts/export-capability-catalog.ts"],
    check: null,
    checkedBy: "Capability catalog drift guard",
    autofix: true,
    after: ["visual-sandbox-bundle"],
  },
  {
    id: "capability-runtime",
    outputKind: "derived",
    outputs: [
      ...CI_GENERATED_OUTPUTS.capabilityRuntime,
      "apps/api/src/mcp/generated/capability-dispatch/*.ts",
    ],
    inputs: CAPABILITY_RUNTIME_INPUTS,
    write: ["bun", "apps/api/scripts/generate-capability-runtime.ts"],
    check: null,
    checkedBy: "CLI sharded registry and derived runtime guard",
    autofix: true,
    after: ["capability-catalog"],
  },
  {
    id: "cli-registry",
    outputKind: "committed",
    outputs: [
      "packages/cli/src/generated/api-contract.ts",
      "packages/cli/src/generated/cli-version.ts",
      "packages/cli/src/generated/document-version-upload-transport.ts",
      "packages/cli/src/generated/mcp-contract.ts",
      "packages/cli/src/generated/registry-snapshot.json",
      ...CI_GENERATED_OUTPUTS.cliRegistry,
      "packages/cli/src/generated/resource-tree.ts",
      "packages/cli/src/generated/resources-snapshot.json",
      "packages/cli/skills/**",
      "packages/api-contract/src/mcp-chat-tool-policy.gen.ts",
    ],
    inputs: [
      "apps/api/src/mcp/**",
      "apps/api/src/handlers/**",
      "apps/api/scripts/export-mcp-tool-registry.ts",
      "apps/api/src/lib/chat/projections.ts",
      "apps/api/src/lib/chat/case-law-result-projections.ts",
      "apps/api/src/lib/chat/case-law-citation-projection.ts",
      "apps/api/src/lib/chat/case-law-court-projection.ts",
      "apps/api/src/lib/chat/legislation-result-projections.ts",
      "apps/api/src/lib/chat/projection-fields.ts",
      "apps/api/src/lib/legal-search/legislation-provision-vocabulary.ts",
      "apps/api/src/lib/case-law/citation-vocabulary.ts",
      "apps/api/src/lib/case-law/search-warnings.ts",
      "apps/api/src/lib/search/pagination-outcome-projection.ts",
      "packages/api-contract/src/case-law-court-year.ts",
      "packages/api-contract/src/document-version-upload.ts",
      "packages/api-contract/src/statute-version.ts",
      "packages/api-contract/src/mcp-tool-name.ts",
      "packages/api-contract/src/mcp-capability-executors.ts",
      "bunfig.toml",
      "packages/cli/src/**",
      "packages/cli/package.json",
      "packages/cli/capabilities/**",
    ],
    write: ["bun", "--cwd=packages/cli", "run", "codegen"],
    check: null,
    checkedBy: "CLI sharded registry and derived runtime guard",
    autofix: true,
    after: ["capability-runtime", "mcp-app-bundles"],
  },
  {
    id: "cli-runtime",
    outputKind: "derived",
    outputs: CI_GENERATED_OUTPUTS.cliRuntime,
    inputs: [
      "packages/cli/package.json",
      "packages/cli/capabilities/**",
      "packages/cli/src/codegen.ts",
      "packages/cli/src/capability-catalog-data.ts",
      "packages/cli/src/write-generated-file.ts",
      "packages/cli/src/capability-catalog-load.ts",
      "packages/cli/src/generate-capability-tree.ts",
      "packages/cli/src/generate-route-map.ts",
      "packages/cli/src/annotations.ts",
      "packages/cli/src/expand-schema-defs.ts",
      "packages/cli/src/flag-name.ts",
      "packages/cli/src/route-types.ts",
      "packages/cli/src/generated/registry-snapshot.json",
      "packages/cli/src/generated/mcp-contract.ts",
      "package.json",
      "bunfig.toml",
      "bun.lock",
      "patches/**",
    ],
    write: ["bun", "--cwd=packages/cli", "run", "codegen:runtime"],
    check: null,
    checkedBy: "CLI sharded registry and derived runtime guard",
    autofix: true,
    after: ["cli-registry"],
  },
  {
    id: "mcp-app-contracts",
    outputKind: "derived",
    outputs: [...MCP_APP_GENERATED_OUTPUTS.contracts],
    inputs: [
      "apps/api/scripts/generate-mcp-app-contracts.ts",
      "scripts/generated-artifacts.ts",
      "bunfig.toml",
      "apps/api/src/mcp/app-browser-contracts.ts",
      "apps/api/src/mcp/app-contracts.ts",
      "apps/api/src/mcp/web-handoff-link-contract.ts",
      "apps/api/src/mcp/write-result-omission.ts",
      "apps/api/src/mcp/decision-reader-contract.ts",
      "apps/api/src/mcp/valibot-tool-definition.ts",
      "apps/api/src/lib/chat/*projection*.ts",
      "apps/api/src/lib/legal-search/legislation-provision-vocabulary.ts",
      "apps/api/src/lib/case-law/citation-vocabulary.ts",
      "apps/api/src/lib/case-law/search-warnings.ts",
      "apps/api/src/lib/search/pagination-outcome-projection.ts",
      "apps/api/src/lib/json-schema/**",
      "packages/mcp-apps/src/manifest.ts",
      "packages/api-contract/**",
      "packages/legal-ast/**",
      "bun.lock",
    ],
    write: ["bun", "--cwd=apps/api", "run", "generate:mcp-app-contracts"],
    prepare: ["bun", "--cwd=packages/mcp-apps", "run", "build"],
    check: ["bun", "scripts/check-mcp-generated-tracking.ts"],
    checkedBy: "MCP app derived outputs guard",
    autofix: true,
    after: [],
  },
  {
    id: "api-typecheck-projects",
    outputKind: "committed",
    outputs: [
      "apps/api/tsconfig.declarations.json",
      "apps/api/tsconfig.src.json",
      "apps/api/tsconfig.tests.json",
      "turbo.json",
    ],
    inputs: [
      "apps/api/**",
      "apps/*/tsconfig*.json",
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "packages/**/tsconfig*.json",
      "{apps,packages}/*/package.json",
      "scripts/**/*.ts",
      "tsconfig*.json",
      "types/**",
      "package.json",
      "bunfig.toml",
      ".npmrc",
      "bun.lock",
      "patches/**",
    ],
    write: ["bun", "packages/scripts/src/api-typecheck-regenerate.ts"],
    check: ["bun", "scripts/typecheck-coverage.ts"],
    checkedBy: "Typecheck coverage",
    autofix: true,
    after: ["cli-runtime", "capability-runtime"],
  },
  {
    id: "mcp-app-bundles",
    outputKind: "derived",
    outputs: [
      "packages/mcp-apps/src/*/generated/app.html.txt",
      ...MCP_APP_GENERATED_OUTPUTS.bundles,
    ],
    inputs: [
      "packages/mcp-apps/src/**",
      "packages/mcp-apps/scripts/build-mcp-apps.ts",
      "packages/mcp-apps/scripts/lib/mcp-app-html-guard.ts",
      "packages/mcp-apps/scripts/lib/mcp-reader-ui-guard.ts",
      "packages/scripts/src/react-compiler-options.ts",
      "scripts/generated-artifacts.ts",
      "bunfig.toml",
      "apps/api/src/lib/chat/legislation-result-projections.ts",
      "apps/api/src/lib/legal-search/legislation-provision-vocabulary.ts",
      "packages/api-contract/src/case-law-court-year.ts",
      "apps/web/src/fonts.css",
      "apps/web/src/i18n/langs/*.json",
      "packages/decision-reader/**",
      "packages/legal-ast/**",
      "apps/web/public/fonts/**",
      "packages/ui/**",
      "packages/locales/**",
      "packages/api-contract/**",
      "packages/fetch/**",
      "bun.lock",
    ],
    write: ["bun", "packages/mcp-apps/scripts/build-mcp-apps.ts"],
    prepare: ["bun", "--cwd=packages/mcp-apps", "run", "build"],
    check: ["bun", "scripts/check-mcp-generated-tracking.ts"],
    checkedBy: "MCP app derived outputs guard",
    autofix: true,
    after: ["mcp-app-contracts"],
  },
  {
    id: "scan-engine-fixtures",
    outputKind: "committed",
    outputs: ["packages/scan-engine/fixtures/*.pgm"],
    inputs: ["packages/scan-engine/scripts/generate-fixtures.ts"],
    write: ["bun", "--cwd=packages/scan-engine", "run", "generate:fixtures"],
    check: ["bun", "--cwd=packages/scan-engine", "run", "check:fixtures"],
    autofix: true,
    after: [],
  },
  {
    id: "scan-engine-wasm",
    outputKind: "committed",
    outputs: ["packages/scan-engine/generated/*"],
    inputs: [
      "packages/scan-engine/Cargo.lock",
      "packages/scan-engine/Cargo.toml",
      "packages/scan-engine/rust-toolchain.toml",
      "packages/scan-engine/scripts/build-wasm.sh",
      "packages/scan-engine/scripts/wasm-toolchain.sh",
      "packages/scan-engine/src/*.rs",
    ],
    write: ["bun", "--cwd=packages/scan-engine", "run", "build:wasm"],
    check: ["bash", "packages/scan-engine/scripts/test-wasm-offline.sh"],
    checkedBy: "Check generated WebAssembly from a fresh Cargo cache",
    autofix: false,
    after: [],
  },
  {
    id: "visual-sandbox-bundle",
    outputKind: "committed",
    outputs: ["apps/api/src/handlers/visual-sandbox/generated/runtime.js.txt"],
    inputs: [
      "apps/api/src/handlers/visual-sandbox/**",
      "apps/api/scripts/build-visual-sandbox.ts",
      "apps/api/scripts/visual-sandbox-build-options.ts",
      "packages/api-contract/**",
      "packages/errors/**",
      "bun.lock",
    ],
    write: ["bun", "--cwd=apps/api", "run", "build:visual-sandbox"],
    check: null,
    checkedBy: "Visual sandbox document tests",
    autofix: true,
    after: [],
  },
  {
    id: "mcp-surface",
    outputKind: "committed",
    outputs: ["apps/api/mcp-surface-baseline.json"],
    inputs: [
      "apps/api/src/**",
      "apps/api/src/mcp/**",
      "apps/api/src/handlers/**",
      "apps/api/scripts/mcp-surface-baseline.ts",
      "packages/api-contract/**",
      "packages/**",
    ],
    write: ["bun", "--cwd=apps/api", "run", "mcp:surface-baseline", "--write"],
    check: ["bun", "--cwd=apps/api", "run", "mcp:surface-baseline", "--check"],
    // Its output is a protected baseline: autofix may never write it.
    autofix: false,
    after: ["capability-catalog", "cli-registry"],
  },
  {
    id: "module-ownership",
    outputKind: "committed",
    outputs: ["docs/module-ownership.md", "docs/module-ownership/*.md"],
    inputs: [
      "scripts/ownership.ts",
      "scripts/ownership/*.ts",
      "scripts/ownership-loader.ts",
      "scripts/ownership-types.ts",
      "scripts/generated-artifacts.ts",
      "bunfig.toml",
      "apps/**",
      "packages/**",
    ],
    write: ["bun", "scripts/ownership.ts", "--write"],
    check: null,
    checkedBy: "Module ownership",
    autofix: true,
    after: [],
  },
  {
    // Refreshes only the reviewed digests of jobs whose kind, qualifier and
    // privilege are unchanged since the merge base; new, reclassified and
    // privileged jobs keep failing the check until a human reviews them.
    // This file loads without imports in reduced checkouts, so the paths are
    // spelled out; a test binds them to scripts/ci-job-classification/inputs.ts.
    id: "ci-job-classification-digests",
    outputKind: "committed",
    outputs: [
      ".github/ci-job-classification-decisions/**",
      ".github/ci-job-classification-sources.json",
    ],
    inputs: [
      ".github/workflows/**",
      ".github/actions/**",
      ".github/ci-job-classification-decisions/**",
      ".github/ci-job-classification-sources.json",
      "scripts/check-ci-job-classification.ts",
      "scripts/ci-job-classification/**",
      "packages/collation/src/collation.ts",
      "packages/sha256/src/node.ts",
      "packages/sha256/src/types.ts",
    ],
    write: ["bun", "scripts/check-ci-job-classification.ts", "--write"],
    check: null,
    checkedBy: "Check workflow job classifications",
    // The check reads git history, so it cannot load the offline network
    // preload every `--check` command must use; it runs as the default mode.
    checkedWith: ["bun", "scripts/check-ci-job-classification.ts"],
    autofix: true,
    after: [],
  },
  {
    id: "design-tokens",
    outputKind: "committed",
    outputs: ["DESIGN.md"],
    blocks: [
      {
        path: "DESIGN.md",
        begin: "<!-- BEGIN GENERATED DESIGN TOKENS -->",
        end: "<!-- END GENERATED DESIGN TOKENS -->",
      },
      {
        path: "DESIGN.md",
        begin: "<!-- BEGIN GENERATED FONT STACK -->",
        end: "<!-- END GENERATED FONT STACK -->",
      },
    ],
    inputs: [
      "packages/ui/src/styles/theme.css",
      "scripts/design-tokens-doc.ts",
      "scripts/generated-artifacts.ts",
      "bunfig.toml",
    ],
    write: ["bun", "scripts/design-tokens-doc.ts", "--write"],
    check: null,
    checkedBy: "Design token docs",
    autofix: true,
    after: [],
  },
  {
    id: "published-package-list",
    outputKind: "committed",
    outputs: ["CONTRIBUTING.md", ".changeset/README.md"],
    blocks: [
      {
        path: "CONTRIBUTING.md",
        begin: "<!-- published-packages:start -->",
        end: "<!-- published-packages:end -->",
      },
      {
        path: ".changeset/README.md",
        begin: "<!-- published-packages:start -->",
        end: "<!-- published-packages:end -->",
      },
    ],
    inputs: [
      "scripts/changeset-policy.json",
      "scripts/check-published-package-lists.ts",
    ],
    write: ["bun", "scripts/check-published-package-lists.ts", "--write"],
    check: null,
    checkedBy: "Published package lists match the release policy",
    autofix: false,
    after: [],
  },
  {
    id: "route-tree",
    outputKind: "derived",
    outputs: CI_GENERATED_OUTPUTS.routeTree,
    inputs: [
      "apps/web/src/routes/**",
      "apps/web/vite.config.ts",
      "apps/web/route-tree.config.ts",
      "apps/web/scripts/route-template-manifest.ts",
      "apps/web/scripts/generate-route-tree.ts",
      "packages/scripts/src/prepared-generated-sources.ts",
      "packages/scripts/src/generated-input-identity.ts",
      "scripts/generated-files.ts",
      "packages/scripts/src/generated-files.ts",
      "apps/web/package.json",
      "bun.lock",
    ],
    write: ["bun", "--filter", "@stll/web", "generate:route-tree"],
    check: null,
    checkedBy: "Route tree drift guard",
    autofix: true,
    after: [],
  },
  {
    id: "model-catalog-inputs",
    outputKind: "committed",
    outputs: [
      "packages/ai-catalog/upstream/models.dev.gen.json",
      "packages/ai-catalog/upstream/openrouter.gen.json",
    ],
    inputs: [
      ...MODEL_CATALOG_INPUTS,
      "packages/scripts/src/model-catalog-snapshot.ts",
      "packages/ai-catalog/upstream/*.gen.json",
      "scripts/offline-network-preload.ts",
    ],
    write: ["bun", "--filter", "@stll/ai-catalog", "gen:rates", "--refresh"],
    check: ["bun", "--filter", "@stll/ai-catalog", "gen:rates", "--check"],
    autofix: false,
    after: [],
  },
  {
    id: "model-rates",
    outputKind: "committed",
    outputs: ["packages/ai-catalog/src/model-rates.gen.ts"],
    inputs: MODEL_CATALOG_INPUTS,
    write: ["bun", "--filter", "@stll/ai-catalog", "gen:rates"],
    check: null,
    checkedBy: "Model catalog snapshot drift check",
    autofix: false,
    after: [],
  },
  {
    id: "model-capabilities",
    outputKind: "committed",
    outputs: ["packages/ai-catalog/src/capabilities.gen.ts"],
    inputs: MODEL_CATALOG_INPUTS,
    write: ["bun", "--filter", "@stll/ai-catalog", "gen:capabilities"],
    check: null,
    checkedBy: "Model catalog snapshot drift check",
    autofix: false,
    after: [],
  },
  {
    id: "model-benchmarks",
    outputKind: "committed",
    outputs: ["packages/ai-catalog/src/benchmarks.gen.ts"],
    inputs: [
      "packages/ai-catalog/package.json",
      "packages/ai-catalog/src/benchmark-sources.ts",
      "packages/ai-catalog/src/benchmarks.ts",
      "packages/ai-catalog/src/index.ts",
      "packages/scripts/src/model-catalog-benchmarks-gen.ts",
      "packages/scripts/src/model-catalog-rates-gen.ts",
    ],
    write: ["bun", "--filter", "@stll/ai-catalog", "gen:benchmarks"],
    check: null,
    unchecked:
      "The Text Arena snapshot is refreshed on demand; its network check is not a pull request gate",
    autofix: false,
    after: [],
  },
  {
    id: "i18n-messages-web",
    outputKind: "derived",
    outputs: CI_GENERATED_OUTPUTS.webMessages,
    inputs: [
      "apps/web/src/i18n/langs/*.json",
      "packages/scripts/src/i18n-typegen.ts",
      "apps/web/package.json",
    ],
    write: ["bun", "--filter", "@stll/web", "generate:messages"],
    check: null,
    unchecked:
      "derived on demand; the web i18n check validates the source catalogs",
    autofix: false,
    after: [],
  },
  {
    id: "i18n-messages-landing",
    outputKind: "committed",
    outputs: ["apps/landing/src/i18n/messages/messages.gen.ts"],
    inputs: [
      "apps/landing/src/i18n/messages/*.json",
      "packages/scripts/src/i18n-typegen.ts",
    ],
    write: [
      "bun",
      "packages/scripts/src/i18n-typegen.ts",
      "apps/landing/src/i18n/messages",
    ],
    check: [
      "bun",
      "packages/scripts/src/i18n-typegen.ts",
      "apps/landing/src/i18n/messages",
      "--check",
    ],
    autofix: true,
    after: [],
  },
  {
    id: "i18n-messages-transactional",
    outputKind: "committed",
    outputs: ["packages/transactional/i18n/langs/messages.gen.ts"],
    inputs: [
      "packages/transactional/i18n/langs/*.json",
      "packages/scripts/src/i18n-typegen.ts",
    ],
    write: [
      "bun",
      "packages/scripts/src/i18n-typegen.ts",
      "packages/transactional/i18n/langs",
    ],
    check: [
      "bun",
      "packages/scripts/src/i18n-typegen.ts",
      "packages/transactional/i18n/langs",
      "--check",
    ],
    autofix: true,
    after: [],
  },
  {
    id: "i18n-glossary",
    outputKind: "committed",
    outputs: ["apps/web/src/i18n/TERMINOLOGY.md"],
    blocks: [
      ...[
        "verbs-slavic-baltic",
        "verbs-romance",
        "verbs-arabic",
        "legal-slavic-baltic",
        "legal-romance",
        "legal-arabic",
        "ptbr-special",
      ].map((section) => ({
        path: "apps/web/src/i18n/TERMINOLOGY.md",
        begin: `<!-- glossary-gen:${section} start -->`,
        end: `<!-- glossary-gen:${section} end -->`,
      })),
    ],
    inputs: [
      "apps/web/src/i18n/glossary.json",
      "packages/scripts/src/glossary-gen.ts",
      "packages/scripts/src/generated-artifact-format.ts",
      "packages/text-normalize/src/**",
      "bunfig.toml",
    ],
    write: ["bun", "packages/scripts/src/glossary-gen.ts", "apps/web/src/i18n"],
    check: [
      "bun",
      "packages/scripts/src/glossary-gen.ts",
      "apps/web/src/i18n",
      "--check",
    ],
    autofix: false,
    after: [],
  },
  {
    id: "prepaint-locales",
    outputKind: "committed",
    outputs: CI_GENERATED_OUTPUTS.prepaintLocale,
    blocks: [
      {
        path: "apps/web/public/prepaint-init.js",
        begin: "// <generated:ui-locales>",
        end: "// </generated:ui-locales>",
      },
    ],
    inputs: [
      "packages/locales/**",
      "apps/web/scripts/sync-prepaint-locales.ts",
    ],
    write: ["bun", "apps/web/scripts/sync-prepaint-locales.ts"],
    check: ["bun", "apps/web/scripts/sync-prepaint-locales.ts", "--check"],
    autofix: true,
    after: [],
  },
  {
    id: "env-examples",
    outputKind: "committed",
    outputs: [
      "apps/api/.env.example",
      "apps/web/.env.example",
      "apps/collab/.env.example",
      "packages/runtime-mode/src/secret-examples.generated.ts",
      "apps/web/build-env-contract.json",
    ],
    inputs: [
      "scripts/env-tool.ts",
      "scripts/env-catalog.ts",
      "apps/api/src/env*.ts",
      "apps/web/src/env*.ts",
      "apps/collab/src/env*.ts",
      // Read by the generator: build args and catalog helpers.
      "apps/web/Dockerfile",
      "apps/api/src/db-url.ts",
      "apps/api/src/lib/configuration-placeholders.ts",
      "apps/api/src/lib/rate-limit/budget-config-schema.ts",
      "packages/runtime-mode/src/index.ts",
    ],
    write: ["bun", "run", "env:generate"],
    check: ["bun", "run", "env:check"],
    autofix: true,
    after: [],
  },
  {
    id: "selfhost",
    outputKind: "committed",
    outputs: [
      "docker-compose.selfhost.yml",
      "deploy/selfhost/.env.example",
      "docs/self-hosting.md",
      "docs/releases.md",
    ],
    blocks: [
      {
        path: "docs/self-hosting.md",
        begin: "<!-- BEGIN GENERATED SELF-HOST CONTRACT -->",
        end: "<!-- END GENERATED SELF-HOST CONTRACT -->",
      },
      {
        path: "docs/self-hosting.md",
        begin: "<!-- BEGIN GENERATED SELF-HOST RUN COMMANDS -->",
        end: "<!-- END GENERATED SELF-HOST RUN COMMANDS -->",
      },
      {
        path: "docs/releases.md",
        begin: "<!-- BEGIN GENERATED RELEASE ARTIFACT CONTRACT -->",
        end: "<!-- END GENERATED RELEASE ARTIFACT CONTRACT -->",
      },
    ],
    inputs: [
      "scripts/selfhost-contract.ts",
      "scripts/selfhost-tool.ts",
      "scripts/generated-artifacts.ts",
      "packages/scripts/src/generated-artifact-format.ts",
      "apps/api/src/db/role-names.ts",
      "bunfig.toml",
      "scripts/env-catalog.ts",
      "scripts/env-tool.ts",
      "apps/api/src/env*.ts",
      ".github/workflows/release.yml",
      "scripts/create-release-manifest.sh",
    ],
    write: ["bun", "run", "selfhost:generate"],
    check: ["bun", "run", "selfhost:check"],
    autofix: true,
    after: [],
  },
  {
    id: "desktop-rpc",
    outputKind: "committed",
    outputs: ["packages/api-contract/src/desktop-rpc.gen.ts"],
    inputs: ["apps/desktop/src-tauri/src/types.rs"],
    write: ["bun", "--filter", "@stll/desktop", "rpc:generate"],
    check: null,
    unchecked:
      "Desktop Rust tests exercise the binding; no dedicated byte check runs in CI",
    autofix: false,
    after: [],
  },
  {
    id: "catalogue-pinned-facts",
    outputKind: "committed",
    outputs: ["packages/catalogue/upstream/pinned-content.gen.json"],
    inputs: [
      "packages/catalogue/entries/**",
      "packages/catalogue/scripts/check-pinned-content.ts",
      "packages/catalogue/scripts/pinned-content-facts.ts",
      "packages/catalogue/scripts/pinned-content-upstream.ts",
      "packages/skills/src/**",
      "packages/skills/package.json",
    ],
    write: ["bun", "--filter", "@stll/catalogue", "refresh-pinned"],
    check: ["bun", "--filter", "@stll/catalogue", "check-pinned"],
    autofix: false,
    after: ["catalogue"],
  },
  {
    id: "catalogue",
    outputKind: "committed",
    outputs: [
      "packages/catalogue/src/catalogue.gen.ts",
      "packages/catalogue/src/catalogue-install-payloads.gen.ts",
    ],
    inputs: [
      "packages/catalogue/entries/**",
      "packages/catalogue/scripts/generate-manifest.ts",
      "packages/catalogue/scripts/catalogue-filesystem.ts",
      "packages/catalogue/src/schema.ts",
      "packages/portable-path/src/**",
    ],
    write: ["bun", "--filter", "@stll/catalogue", "generate"],
    check: [
      "bun",
      "--cwd=packages/catalogue",
      "scripts/generate-manifest.ts",
      "--check",
    ],
    autofix: false,
    after: [],
  },
  {
    id: "template-packs",
    outputKind: "committed",
    outputs: [
      "packages/template-packs/src/packs.gen.ts",
      "packages/template-packs/src/fixtures/packs.gen.ts",
    ],
    inputs: [
      "packages/template-packs/content",
      "packages/template-packs/src/fixtures/content/**",
      "packages/template-packs/scripts/generate-manifest.ts",
    ],
    write: ["bun", "--filter", "@stll/template-packs", "generate"],
    check: null,
    unchecked: "Package tests check both manifests without a dedicated CI step",
    autofix: false,
    after: [],
  },
  {
    id: "skill-manifests",
    outputKind: "committed",
    outputs: [
      "packages/skills/src/blueprints.gen.ts",
      "packages/skills/src/skills.gen.ts",
    ],
    inputs: [
      "packages/skills/blueprints/**",
      "packages/skills/skills/**",
      "packages/skills/scripts/generate-manifests.ts",
      "packages/skills/src/format.ts",
    ],
    write: ["bun", "--filter", "@stll/skills", "generate"],
    check: [
      "bun",
      "--cwd=packages/skills",
      "scripts/generate-manifests.ts",
      "--check",
    ],
    autofix: false,
    after: [],
  },
  {
    id: "us-courts",
    outputKind: "committed",
    outputs: [
      "packages/api-contract/src/us-courts.generated.ts",
      "packages/api-contract/src/us-abbreviated-courts.generated.ts",
    ],
    inputs: [
      "packages/api-contract/data/us-courts/**",
      "scripts/generate-us-courts.ts",
      "packages/api-contract/src/us-court-vocabulary.ts",
    ],
    write: ["bun", "scripts/generate-us-courts.ts", "--write"],
    check: ["bun", "scripts/generate-us-courts.ts", "--check"],
    autofix: false,
    after: [],
  },
  {
    id: "us-reporters",
    outputKind: "committed",
    outputs: [
      "packages/api-contract/src/us-reporter-editions.generated.ts",
      "packages/api-contract/src/us-reporters.LICENSE",
    ],
    inputs: ["scripts/generate-us-reporters.ts"],
    write: ["bun", "scripts/generate-us-reporters.ts", "--write"],
    check: null,
    unchecked:
      "Fetched from a pinned upstream commit over the network; a manual upgrade tool outside CI",
    autofix: false,
    after: [],
  },
  {
    id: "snowball",
    outputKind: "committed",
    outputs: [
      "apps/api/src/lib/legal-search/morphology/snowball/*.gen.ts",
      "apps/api/src/lib/legal-search/morphology/snowball/__fixtures__/*.conformance.txt",
    ],
    inputs: ["scripts/generate-snowball-stemmers.ts"],
    write: ["bun", "run", "generate:snowball-stemmers", "--write"],
    check: null,
    unchecked:
      "Conformance tests exercise the stemmers without regenerating them in CI",
    autofix: false,
    after: [],
  },
  {
    id: "infosoud-codes",
    outputKind: "committed",
    outputs: ["packages/infosoud/src/code-catalog.generated.ts"],
    inputs: ["packages/infosoud/scripts/extract-codes.ts"],
    write: ["bun", "--filter", "@stll/infosoud", "extract:codes"],
    check: null,
    unchecked: "Network extraction has no offline CI check",
    autofix: false,
    after: [],
  },
  {
    id: "mojibake-exemplars",
    outputKind: "committed",
    outputs: ["packages/mojibake/src/exemplars.generated.ts"],
    inputs: ["packages/mojibake/scripts/extract-exemplars.ts"],
    write: ["bun", "--filter", "@stll/mojibake", "extract:exemplars"],
    check: null,
    unchecked:
      "Package tests check the pinned exemplar table without a dedicated CI step",
    autofix: false,
    after: [],
  },
  {
    id: "chat-transcripts",
    outputKind: "committed",
    outputs: [
      "apps/web/src/components/chat/__fixtures__/recorded-conversations/*.gen.json",
    ],
    inputs: [
      "apps/api/scripts/gen-chat-transcripts.ts",
      "apps/api/src/lib/chat/**",
      "apps/api/src/tests/**",
    ],
    write: ["bun", "--cwd=apps/api", "run", "gen:chat-transcripts"],
    check: null,
    unchecked:
      "Integration tests exercise recordings without a dedicated CI output check",
    autofix: false,
    after: [],
  },
  {
    // Re-parses the seeded case-law archives through the current parsers
    // (rows with recorded raw) or applies the read-time AST repairs (rows
    // without). It fails instead of re-stamping a stored analysis whose
    // input would change; see apps/api/scripts/reparse-case-law-fixtures.ts.
    id: "case-law-fixture-reparse",
    outputKind: "committed",
    outputs: ["apps/api/scripts/__fixtures__/case-law/*.json.gz"],
    // The re-parse imports the adapters, which reach most of the API source
    // and several packages; any of it can shape the output. A test walks the
    // import graph and fails when a reachable module is not covered here.
    inputs: [
      "apps/api/scripts/reparse-case-law-fixtures.ts",
      "apps/api/scripts/lib/case-law-fixture-reparse.ts",
      "apps/api/scripts/lib/case-law-fixture-analyses.ts",
      "apps/api/src/**",
      "packages/**",
    ],
    write: ["bun", "apps/api/scripts/reparse-case-law-fixtures.ts", "--write"],
    check: ["bun", "apps/api/scripts/reparse-case-law-fixtures.ts", "--check"],
    autofix: true,
    after: [],
  },
  {
    id: "ai-instructions",
    outputKind: "committed",
    outputs: [
      "AGENTS.md",
      "GEMINI.md",
      "apps/*/AGENTS.md",
      "apps/*/GEMINI.md",
      "packages/*/AGENTS.md",
      "packages/*/GEMINI.md",
      "apps/api/src/handlers/case-law/AGENTS.md",
      "apps/api/src/handlers/case-law/GEMINI.md",
      ".agents/skills/**/SKILL.md",
      ".claude/skills/**/SKILL.md",
    ],
    inputs: [
      ".ai/manifest.json",
      ".ai/local/**",
      ".ai/local-skills/**",
      ".ai/shared",
    ],
    write: ["bun", "run", "sync-ai"],
    check: ["bash", ".ai/shared/scripts/sync-ai-skills.sh", "--check", "."],
    autofix: true,
    after: [],
  },
] as const satisfies readonly Generator[];

export const GENERATORS: readonly (Generator & {
  id: (typeof GENERATOR_DECLARATIONS)[number]["id"];
})[] = GENERATOR_DECLARATIONS;

export const GUARD_A_EXCLUSIONS = [
  {
    glob: "provenance/**/THIRD-PARTY-NOTICES*.txt",
    reason: "External provenance workflow output",
  },
  {
    glob: "apps/desktop/dmg/requirements.txt",
    reason: "uv pip compile output",
  },
  { glob: "apps/desktop/src-tauri/Cargo.lock", reason: "Cargo lockfile" },
  {
    glob: "packages/text-normalize/src/ascii-fold-table.ts",
    reason: "Manual SQL export",
  },
  { glob: "**/eu-ecj-fulltext-*.html", reason: "Upstream fixture" },
  {
    glob: "packages/sanctions/src/fixtures/un.xml",
    reason: "Upstream fixture",
  },
  { glob: ".oxlint-plugins/__fixtures__/*", reason: "Upstream fixture" },
  { glob: "**/yara-x.d.ts", reason: "Hand-written declaration" },
  {
    glob: "**/snowball/__fixtures__/vocabulary.ts",
    reason: "Hand-written fixture",
  },
  { glob: "**/glossary.json", reason: "Hand-written source data" },
  {
    glob: "apps/api/src/handlers/case-law/ingestion/parsers/eu-ecj-formex.ts",
    reason: "Hand-written parser documentation",
  },
  {
    glob: "apps/api/src/lib/legal-search/morphology/stem.ts",
    reason: "Hand-written stemmer adapter",
  },
  {
    glob: "apps/landing/src/content/docs/docs/reference/tools.mdx",
    reason: "Hand-written documentation",
  },
  {
    glob: "apps/api/drizzle/*/migration.sql",
    reason: "Hand-written migration",
  },
  { glob: "**/CHANGELOG.md", reason: "Hand-written changelog" },
  { glob: "**/.gitignore", reason: "Hand-written ignore rules" },
] as const;

export const matchesGeneratedGlob = (glob: string, file: string): boolean =>
  new Bun.Glob(glob).match(file);

const globWitness = (glob: string) =>
  glob.replaceAll("**", "example/generated.ts").replaceAll("*", "example");

const outputFeedsInput = (output: string, input: string) =>
  matchesGeneratedGlob(input, globWitness(output)) ||
  matchesGeneratedGlob(output, globWitness(input));

export const generatorsForFiles = (files: readonly string[]) => {
  const selected = new Set<string>(
    GENERATORS.filter(
      (generator) =>
        generator.autofix &&
        [...generator.inputs, ...generator.outputs].some((glob) =>
          files.some((file) => matchesGeneratedGlob(glob, file)),
        ),
    ).map((generator) => generator.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const generator of GENERATORS) {
      if (!generator.autofix || selected.has(generator.id)) {
        continue;
      }
      if (
        generator.after.some((id) => selected.has(id)) ||
        GENERATORS.some(
          (upstream) =>
            selected.has(upstream.id) &&
            upstream.outputs.some((output) =>
              generator.inputs.some((input) => outputFeedsInput(output, input)),
            ),
        )
      ) {
        selected.add(generator.id);
        changed = true;
      }
    }
  }
  // A derived output is never committed, so a clean checkout lacks it: every
  // derived generator a selected one declares in `after` must run first, and
  // so must its own derived prerequisites.
  const pending = [...selected];
  while (pending.length > 0) {
    const id = pending.pop();
    const generator = GENERATORS.find((candidate) => candidate.id === id);
    if (generator === undefined) {
      continue;
    }
    for (const upstream of derivedPrerequisites(generator)) {
      if (!selected.has(upstream.id)) {
        selected.add(upstream.id);
        pending.push(upstream.id);
      }
    }
  }
  return GENERATORS.filter((generator) => selected.has(generator.id));
};

/**
 * Derived generators whose outputs `generator` needs present to run: the
 * derived ones it declares in `after`. (Input globs are too broad to infer
 * this from; a generator that reads a derived output declares it.)
 */
export const derivedPrerequisites = (generator: Generator) =>
  GENERATORS.filter(
    (upstream) =>
      upstream.outputKind === "derived" &&
      generator.after.includes(upstream.id),
  );

/**
 * The check that proves `generator`'s outputs are current, so a run may skip
 * `write`. A derived output is never committed, so a passing check (it guards
 * tracking, not presence) says nothing about whether a clean checkout has it:
 * derived generators always write.
 */
const upToDateCheck = (generator: Generator) =>
  generator.outputKind === "committed" ? generator.check : null;

/**
 * Run `write` for every generator whose outputs are not proven current, in
 * the given order. Returns the first generator that failed, or null.
 */
export const runGenerators = (
  generators: readonly Generator[],
  spawn: (command: readonly string[]) => number,
  log: (line: string) => void = console.log,
): Generator | null => {
  for (const generator of generators) {
    const check = upToDateCheck(generator);
    if (check && spawn(check) === 0) {
      continue;
    }
    log(`Regenerating ${generator.id}`);
    if (spawn(generator.write) !== 0) {
      return generator;
    }
  }
  return null;
};

export const allowedOutputs = (generators: readonly Generator[]) => [
  // A planner cannot authorize recreating the retired ratchet budget.
  ...new Set(
    generators
      .filter((generator) => generator.outputKind === "committed")
      .flatMap((generator) => generator.outputs)
      .filter((output) => output !== "scripts/ratchet-baseline.json"),
  ),
];

export const orderGenerators = (
  generators: readonly Generator[],
): Generator[] => {
  const pending = new Map(
    generators.map((generator) => [generator.id, generator]),
  );
  const ordered: Generator[] = [];
  while (pending.size > 0) {
    const next = [...pending.values()].find((generator) =>
      generator.after.every((id) => !pending.has(id)),
    );
    if (!next) {
      console.error("Generated-file dependency cycle");
      process.exit(1);
    }
    ordered.push(next);
    pending.delete(next.id);
  }
  return ordered;
};
