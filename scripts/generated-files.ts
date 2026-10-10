import { CI_GENERATED_OUTPUTS } from "../packages/scripts/src/generated-files";

export {
  CI_GENERATED_OUTPUTS,
  CI_GENERATED_FILES,
  CI_GENERATION_COMMANDS,
} from "../packages/scripts/src/generated-files";

type GeneratorCheck =
  | { check: readonly string[]; checkedBy?: never; unchecked?: never }
  | { check: null; checkedBy: string; unchecked?: never }
  | { check: null; checkedBy?: never; unchecked: string };

export type Generator = {
  id: string;
  outputKind: "committed" | "derived";
  outputs: readonly string[];
  blocks?: readonly { path: string; begin: string; end: string }[];
  inputs: readonly string[];
  write: readonly string[];
  autofix: boolean;
  after: readonly string[];
} & GeneratorCheck;

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

export const GENERATORS = [
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
    outputs: [
      "packages/cli/capabilities/**",
      "apps/api/src/mcp/generated/capability-dispatch/*.ts",
      "docs/capability-coverage.md",
    ],
    inputs: [
      "apps/api/src/**",
      "apps/api/src/handlers/**",
      "apps/api/src/mcp/**",
      "apps/api/src/lib/capability-transport*",
      "apps/api/scripts/export-capability-catalog.ts",
      "apps/api/scripts/lib/**",
      "packages/cli/src/**",
      "packages/**",
      ".oxfmtrc.json",
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
    outputs: CI_GENERATED_OUTPUTS.capabilityRuntime,
    inputs: [
      "packages/cli/capabilities/**",
      "apps/api/src/mcp/generated/capability-dispatch/*.ts",
      "apps/api/scripts/generate-capability-runtime.ts",
      "packages/cli/src/capability-catalog-data.ts",
    ],
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
      "packages/cli/src/generated/resource-tree.ts",
      "packages/cli/src/generated/resources-snapshot.json",
      "packages/cli/skills/**",
      "chatgpt-app-submission.json",
      "packages/api-contract/src/mcp-chat-tool-policy.gen.ts",
    ],
    inputs: [
      "apps/api/src/mcp/**",
      "apps/api/src/handlers/**",
      "apps/api/scripts/export-mcp-tool-registry.ts",
      "apps/api/src/lib/chat/projections.ts",
      "apps/api/src/lib/chat/case-law-result-projections.ts",
      "apps/api/src/lib/chat/case-law-court-projection.ts",
      "packages/api-contract/src/case-law-court-year.ts",
      "packages/api-contract/src/mcp-tool-name.ts",
      "packages/api-contract/src/mcp-capability-executors.ts",
      ".oxfmtrc.json",
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
    outputKind: "committed",
    outputs: [
      "packages/mcp-apps/src/shared/generated/schemas.json",
      "packages/mcp-apps/src/shared/generated/contracts.js",
      "packages/mcp-apps/src/shared/generated/contracts.d.ts",
    ],
    inputs: [
      "apps/api/scripts/generate-mcp-app-contracts.ts",
      "scripts/generated-artifacts.ts",
      ".oxfmtrc.json",
      "apps/api/src/mcp/app-browser-contracts.ts",
      "apps/api/src/mcp/app-contracts.ts",
      "apps/api/src/mcp/decision-reader-contract.ts",
      "apps/api/src/mcp/valibot-tool-definition.ts",
      "apps/api/src/lib/chat/*projection*.ts",
      "apps/api/src/lib/case-law/decision-lookup-vocabulary.ts",
      "apps/api/src/lib/case-law/search-warnings.ts",
      "apps/api/src/lib/search/pagination-outcome-projection.ts",
      "apps/api/src/lib/json-schema/**",
      "packages/mcp-apps/src/manifest.ts",
      "packages/api-contract/**",
      "packages/legal-ast/**",
      "bun.lock",
    ],
    write: ["bun", "--cwd=apps/api", "run", "generate:mcp-app-contracts"],
    check: null,
    checkedBy: "MCP App bundle and shared assets guard",
    autofix: true,
    after: [],
  },
  {
    id: "mcp-app-bundles",
    outputKind: "committed",
    outputs: [
      "packages/mcp-apps/src/*/generated/app.html.txt",
      "packages/mcp-apps/src/shared/generated/messages.json",
      "packages/mcp-apps/src/shared/generated/reader-messages.json",
      "packages/mcp-apps/src/shared/generated/reader-inputs.json",
      "packages/mcp-apps/src/shared/generated/style.css",
      "packages/mcp-apps/src/generated/bundles.ts",
    ],
    inputs: [
      "packages/mcp-apps/src/**",
      "packages/mcp-apps/scripts/build-mcp-apps.ts",
      "packages/mcp-apps/scripts/lib/mcp-app-html-guard.ts",
      "packages/mcp-apps/scripts/lib/mcp-reader-ui-guard.ts",
      "packages/scripts/src/react-compiler-options.ts",
      "scripts/generated-artifacts.ts",
      ".oxfmtrc.json",
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
    write: ["bun", "--cwd=packages/mcp-apps", "run", "build"],
    check: null,
    checkedBy: "MCP App bundle and shared assets guard",
    autofix: true,
    after: ["mcp-app-contracts"],
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
    autofix: true,
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
      ".oxfmtrc.json",
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
      ".oxfmtrc.json",
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
      "apps/web/scripts/generate-route-tree.ts",
      "packages/scripts/src/prepared-generated-sources.ts",
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
    outputKind: "committed",
    outputs: CI_GENERATED_OUTPUTS.webMessages,
    inputs: [
      "apps/web/src/i18n/langs/*.json",
      "packages/scripts/src/i18n-typegen.ts",
    ],
    write: [
      "bun",
      "packages/scripts/src/i18n-typegen.ts",
      "apps/web/src/i18n/langs",
    ],
    check: [
      "bun",
      "packages/scripts/src/i18n-typegen.ts",
      "apps/web/src/i18n/langs",
      "--check",
    ],
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
    autofix: false,
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
    autofix: false,
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
    autofix: false,
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
    ],
    write: ["bun", "run", "env:generate"],
    check: ["bun", "run", "env:check"],
    autofix: false,
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
      ".oxfmtrc.json",
      "scripts/env-catalog.ts",
      "scripts/env-tool.ts",
      "apps/api/src/env*.ts",
      ".github/workflows/release.yml",
      "scripts/create-release-manifest.sh",
    ],
    write: ["bun", "run", "selfhost:generate"],
    check: ["bun", "run", "selfhost:check"],
    autofix: false,
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
      "packages/skills/src/loader.ts",
      "packages/skills/src/resource-kinds.ts",
      "packages/skills/src/package-limits.ts",
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
    id: "skill-blueprints",
    outputKind: "committed",
    outputs: ["packages/skills/src/blueprints.gen.ts"],
    inputs: [
      "packages/skills/blueprints/**",
      "packages/skills/scripts/generate-blueprints-manifest.ts",
    ],
    write: ["bun", "--filter", "@stll/skills", "generate"],
    check: [
      "bun",
      "--cwd=packages/skills",
      "scripts/generate-blueprints-manifest.ts",
      "--check",
    ],
    autofix: false,
    after: [],
  },
  {
    id: "built-in-skills",
    outputKind: "committed",
    outputs: ["packages/skills/src/skills.gen.ts"],
    inputs: [
      "packages/skills/skills/**",
      "packages/skills/scripts/generate-manifest.ts",
    ],
    write: ["bun", "--filter", "@stll/skills", "generate"],
    check: [
      "bun",
      "--cwd=packages/skills",
      "scripts/generate-manifest.ts",
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
    inputs: [".ai/manifest.json", ".ai/local/**", ".ai/shared"],
    write: ["bun", "run", "sync-ai"],
    check: ["bash", ".ai/shared/scripts/sync-ai-skills.sh", "--check", "."],
    autofix: false,
    after: [],
  },
] as const satisfies readonly Generator[];

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
  const selected = new Set(
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
  return GENERATORS.filter((generator) => selected.has(generator.id));
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
