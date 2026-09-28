export type Generator = {
  id: string;
  outputs: readonly string[];
  blocks?: readonly { path: string; begin: string; end: string }[];
  inputs: readonly string[];
  write: readonly string[];
  check: readonly string[] | null;
  checkedBy?: string;
  autofix: boolean;
  after: readonly string[];
};

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
    id: "capability-catalog",
    outputs: [
      "packages/cli/capability-catalog.json",
      "apps/api/src/mcp/generated/capability-dispatch.ts",
      "docs/capability-coverage.md",
    ],
    inputs: [
      "apps/api/src/handlers/**",
      "apps/api/scripts/export-capability-catalog.ts",
      "scripts/lib/**",
      ".oxfmtrc.json",
    ],
    write: ["bun", "apps/api/scripts/export-capability-catalog.ts"],
    check: null,
    checkedBy: "Capability catalog drift guard",
    autofix: true,
    after: [],
  },
  {
    id: "cli-registry",
    outputs: [
      "packages/cli/src/generated/**",
      "packages/cli/skills/**",
      "chatgpt-app-submission.json",
      "packages/api-contract/src/mcp-chat-tool-policy.gen.ts",
    ],
    inputs: [
      "apps/api/src/mcp/**",
      "apps/api/src/handlers/**",
      "packages/cli/src/**",
      "packages/cli/package.json",
      "packages/cli/capability-catalog.json",
    ],
    write: ["bun", "--cwd=packages/cli", "run", "codegen"],
    check: null,
    checkedBy: "CLI registry snapshot guard",
    autofix: true,
    after: ["capability-catalog"],
  },
  {
    id: "mcp-app-bundles",
    outputs: ["apps/api/src/mcp/apps/*/generated/app.html.txt"],
    inputs: [
      "apps/api/src/mcp/apps/**",
      "apps/api/scripts/build-mcp-apps.ts",
      "bun.lock",
    ],
    write: ["bun", "--cwd=apps/api", "run", "build:mcp-apps"],
    check: null,
    checkedBy: "MCP App bundle guard",
    autofix: true,
    after: [],
  },
  {
    id: "web-api-types",
    outputs: ["apps/web/src/generated/api-routes.gen.ts"],
    inputs: [
      "apps/api/**",
      "apps/web/package.json",
      "apps/web/src/generated/**",
      "packages/**",
      "patches/**",
      "types/**",
      "bun.lock",
      "bunfig.toml",
      "package.json",
      ".github/workflows/ci.yml",
    ],
    write: ["bun", "--filter", "@stll/api", "gen:web-api-types"],
    check: null,
    checkedBy: "Web API types drift guard",
    autofix: true,
    after: [],
  },
  {
    id: "mcp-surface",
    outputs: ["apps/api/mcp-surface-baseline.json"],
    inputs: ["apps/api/src/mcp/**", "apps/api/scripts/mcp-surface-baseline.ts"],
    write: ["bun", "--cwd=apps/api", "run", "mcp:surface-baseline", "--write"],
    check: ["bun", "--cwd=apps/api", "run", "mcp:surface-baseline", "--check"],
    checkedBy: "MCP registry quality test",
    autofix: true,
    after: ["capability-catalog", "cli-registry"],
  },
  {
    id: "module-ownership",
    outputs: ["docs/module-ownership.md"],
    inputs: ["scripts/ownership.ts", "apps/**", "packages/**"],
    write: ["bun", "scripts/ownership.ts", "--write"],
    check: null,
    checkedBy: "Module ownership",
    autofix: true,
    after: [],
  },
  {
    id: "design-tokens",
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
    ],
    write: ["bun", "scripts/design-tokens-doc.ts", "--write"],
    check: null,
    checkedBy: "Design token docs",
    autofix: true,
    after: [],
  },
  {
    id: "published-package-list",
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
    checkedBy: "Published package lists guard",
    autofix: true,
    after: [],
  },
  {
    id: "route-tree",
    outputs: ["apps/web/src/routeTree.gen.ts"],
    inputs: [
      "apps/web/src/routes/**",
      "apps/web/vite.config.ts",
      "apps/web/scripts/generate-route-tree.ts",
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
    id: "model-rates",
    outputs: ["packages/ai-catalog/src/model-rates.gen.ts"],
    inputs: MODEL_CATALOG_INPUTS,
    write: ["bun", "--filter", "@stll/ai-catalog", "gen:rates"],
    check: null,
    checkedBy: "Model catalog snapshot drift guard",
    autofix: false,
    after: [],
  },
  {
    id: "model-capabilities",
    outputs: ["packages/ai-catalog/src/capabilities.gen.ts"],
    inputs: MODEL_CATALOG_INPUTS,
    write: ["bun", "--filter", "@stll/ai-catalog", "gen:capabilities"],
    check: null,
    checkedBy: "Model catalog snapshot drift guard",
    autofix: false,
    after: [],
  },
  {
    id: "i18n-messages-web",
    outputs: ["apps/web/src/i18n/langs/messages.gen.ts"],
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
    autofix: true,
    after: [],
  },
  {
    id: "i18n-messages-landing",
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
    autofix: true,
    after: [],
  },
  {
    id: "prepaint-locales",
    outputs: ["apps/web/public/prepaint-init.js"],
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
    outputs: [
      "apps/api/.env.example",
      "apps/web/.env.example",
      "apps/collab/.env.example",
    ],
    inputs: [
      "scripts/env-tool.ts",
      "scripts/env-catalog.ts",
      "apps/api/src/lib/env*.ts",
      "apps/web/src/lib/env*.ts",
      "apps/collab/src/lib/env*.ts",
    ],
    write: ["bun", "run", "env:generate"],
    check: ["bun", "run", "env:check"],
    autofix: true,
    after: [],
  },
  {
    id: "selfhost",
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
    outputs: ["packages/api-contract/src/desktop-rpc.gen.ts"],
    inputs: ["apps/desktop/src-tauri/src/types.rs"],
    write: ["bun", "--filter", "@stll/desktop", "rpc:generate"],
    check: null,
    checkedBy: "Desktop Rust checks",
    autofix: false,
    after: [],
  },
  {
    id: "catalogue",
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
    autofix: true,
    after: [],
  },
  {
    id: "template-packs",
    outputs: [
      "packages/template-packs/src/packs.gen.ts",
      "packages/template-packs/src/fixtures/packs.gen.ts",
    ],
    inputs: [
      "packages/template-packs/content/**",
      "packages/template-packs/fixtures/**",
      "packages/template-packs/scripts/generate-manifest.ts",
    ],
    write: ["bun", "--filter", "@stll/template-packs", "generate"],
    check: null,
    checkedBy: "Template packs package test",
    autofix: true,
    after: [],
  },
  {
    id: "skill-blueprints",
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
    autofix: true,
    after: [],
  },
  {
    id: "us-courts",
    outputs: [
      "packages/api-contract/src/us-courts.generated.ts",
      "packages/api-contract/src/us-writable-courts.generated.ts",
    ],
    inputs: [
      "data/us-courts/**",
      "scripts/generate-us-courts.ts",
      "packages/api-contract/src/vocabulary/**",
    ],
    write: ["bun", "scripts/generate-us-courts.ts", "--write"],
    check: ["bun", "scripts/generate-us-courts.ts", "--check"],
    autofix: true,
    after: [],
  },
  {
    id: "snowball",
    outputs: [
      "apps/api/src/lib/legal-search/morphology/snowball/*.gen.ts",
      "apps/api/src/lib/legal-search/morphology/snowball/__fixtures__/**",
    ],
    inputs: ["scripts/generate-snowball-stemmers.ts"],
    write: ["bun", "run", "generate:snowball-stemmers", "--write"],
    check: null,
    checkedBy: "Snowball conformance test",
    autofix: false,
    after: [],
  },
  {
    id: "infosoud-codes",
    outputs: ["packages/infosoud/src/code-catalog.generated.ts"],
    inputs: ["packages/infosoud/scripts/extract-codes.ts"],
    write: ["bun", "--filter", "@stll/infosoud", "extract:codes"],
    check: null,
    checkedBy: "Manual network extraction",
    autofix: false,
    after: [],
  },
  {
    id: "mojibake-exemplars",
    outputs: ["packages/mojibake/src/exemplars.generated.ts"],
    inputs: ["packages/mojibake/scripts/extract-exemplars.ts"],
    write: ["bun", "--filter", "@stll/mojibake", "extract:exemplars"],
    check: null,
    checkedBy: "Mojibake exemplars test",
    autofix: false,
    after: [],
  },
  {
    id: "chat-transcripts",
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
    checkedBy: "Chat integration test",
    autofix: false,
    after: [],
  },
  {
    id: "ai-instructions",
    outputs: [
      "AGENTS.md",
      "GEMINI.md",
      "apps/*/AGENTS.md",
      "apps/*/GEMINI.md",
      "packages/*/AGENTS.md",
      "packages/*/GEMINI.md",
      ".agents/skills/**/SKILL.md",
      ".claude/skills/**/SKILL.md",
    ],
    inputs: [".ai/manifest.json", ".ai/local/**", ".ai/shared/**"],
    write: ["bun", "run", "sync-ai"],
    check: null,
    checkedBy: "AI skill sync",
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
  { glob: "docs/reference/tools.mdx", reason: "Hand-written documentation" },
  {
    glob: "apps/api/drizzle/*/migration.sql",
    reason: "Hand-written migration",
  },
  { glob: "**/CHANGELOG.md", reason: "Hand-written changelog" },
  { glob: "**/.gitignore", reason: "Hand-written ignore rules" },
] as const;

export const matchesGeneratedGlob = (glob: string, file: string): boolean =>
  new Bun.Glob(glob).match(file);

export const generatorsForFiles = (files: readonly string[]) =>
  GENERATORS.filter(
    (generator) =>
      generator.autofix &&
      [...generator.inputs, ...generator.outputs].some((glob) =>
        files.some((file) => matchesGeneratedGlob(glob, file)),
      ),
  );

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
