import {
  type Expression,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";

export type BundledConsumerSite = Readonly<{
  file: string;
  command: string;
}>;

type BootCheck =
  | Readonly<{ type: "ci-job"; jobId: string }>
  | Readonly<{ type: "docker-run"; dockerfile: string; run: string }>
  | Readonly<{ type: "none"; reason: string }>;

export type BundledConsumer = BundledConsumerSite &
  Readonly<{ bootCheck: BootCheck }>;

export type RepositoryFile = Readonly<{
  path: string;
  contents: string;
}>;

const normalizeCommand = (command: string): string =>
  command
    .replace(/\\\r?\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const BUN_BUILD_CALL = `Bun.build${String.fromCodePoint(40)}`;

const shellBuildCommands = (shell: string): string[] => {
  const commands: string[] = [];
  const joined = shell.replace(/\\\r?\n/gu, " ");
  const matcher = /\bbun\s+build\b/gu;
  let match = matcher.exec(joined);
  while (match !== null) {
    const remainder = joined.slice(match.index);
    const end = remainder.search(/(?:&&|\|\||;|\r?\n)/u);
    commands.push(
      normalizeCommand(end === -1 ? remainder : remainder.slice(0, end)),
    );
    match = matcher.exec(joined);
  }
  return commands;
};

const isDockerfile = (path: string): boolean =>
  /^(?:apps\/[^/]+|docker\/.*)\/Dockerfile$/u.test(path);

const isWorkspacePackage = (path: string): boolean =>
  /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path);

// Workflows, their shared check fragments and composite actions all run steps.
const isWorkflow = (path: string): boolean =>
  /^\.github\/(?:workflows|ci-checks)\/[^/]+\.ya?ml$/u.test(path) ||
  /^\.github\/actions\/.+\/action\.ya?ml$/u.test(path);

const isBuildScript = (path: string): boolean =>
  !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) &&
  (/^scripts\/.*\.[cm]?[jt]sx?$/u.test(path) ||
    /^(?:apps|packages)\/[^/]+\/scripts\/.*\.[cm]?[jt]sx?$/u.test(path));

const dockerCommands = (contents: string): string[] => {
  const instructions =
    contents.replace(/\\\r?\n/gu, " ").match(/^[ \t]*RUN\b.*$/gimu) ?? [];
  return instructions.flatMap(shellBuildCommands);
};

const packageCommands = (contents: string): string[] => {
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    return [];
  }
  const { scripts } = parsed;
  if (typeof scripts !== "object" || scripts === null) {
    return [];
  }
  return Object.values(scripts).flatMap((script) =>
    typeof script === "string" ? shellBuildCommands(script) : [],
  );
};

// Every `run` script in a workflow or action, whatever its YAML layout
// (`run:` keys, `- run:` list items, block scalars): read from the parsed
// document, never from line shapes.
const runScripts = (node: unknown): string[] => {
  if (Array.isArray(node)) {
    return node.flatMap(runScripts);
  }
  if (typeof node !== "object" || node === null) {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) =>
    key === "run" && typeof value === "string" ? [value] : runScripts(value),
  );
};

// A `Bun.build(...)` call anywhere in the program: read from the syntax tree,
// so a mention in a string or comment never counts and a call never hides
// behind other code on its line.
const isBunBuildCallee = (callee: Expression): boolean =>
  callee.type === "MemberExpression" &&
  callee.object.type === "Identifier" &&
  callee.object.name === "Bun" &&
  (callee.computed
    ? (callee.property.type === "Literal" &&
        callee.property.value === "build") ||
      (callee.property.type === "TemplateLiteral" &&
        callee.property.expressions.length === 0 &&
        callee.property.quasis.at(0)?.value.cooked === "build")
    : callee.property.type === "Identifier" &&
      callee.property.name === "build");

// One site per call, named by what it builds (its `entrypoints`, else its
// whole argument), so a second build in a registered script is a new site.
const bunBuildCalls = (path: string, contents: string): string[] => {
  const source = parseSource(path, contents);
  const calls: string[] = [];
  walk(source.program, (node) => {
    if (node.type !== "CallExpression" || !isBunBuildCallee(node.callee)) {
      return;
    }
    const options = node.arguments.at(0);
    const entrypoints =
      options?.type === "ObjectExpression"
        ? options.properties.find(
            (property) =>
              property.type === "Property" &&
              !property.method &&
              !property.shorthand &&
              property.kind === "init" &&
              contents.slice(property.key.start, property.key.end) ===
                "entrypoints",
          )
        : undefined;
    let built = options ? contents.slice(options.start, options.end) : "";
    if (entrypoints?.type === "Property") {
      built = `entrypoints: ${contents.slice(entrypoints.value.start, entrypoints.value.end)}`;
    }
    calls.push(`${BUN_BUILD_CALL}${normalizeCommand(built)})`);
  });
  return calls;
};

const workflowCommands = (contents: string): string[] =>
  runScripts(Bun.YAML.parse(contents)).flatMap(shellBuildCommands);

export const scanBundledConsumers = (
  files: readonly RepositoryFile[],
): BundledConsumerSite[] =>
  files
    .flatMap(({ path, contents }) => {
      let commands: string[] = [];
      if (isDockerfile(path)) {
        commands = dockerCommands(contents);
      } else if (isWorkspacePackage(path)) {
        commands = packageCommands(contents);
      } else if (isWorkflow(path)) {
        commands = workflowCommands(contents);
      } else if (isBuildScript(path) && contents.includes("Bun")) {
        commands = bunBuildCalls(path, contents);
      }
      return commands.map((command) => ({ file: path, command }));
    })
    .toSorted((left, right) => {
      const leftKey = `${left.file}\0${left.command}`;
      const rightKey = `${right.file}\0${right.command}`;
      if (leftKey < rightKey) {
        return -1;
      }
      if (leftKey > rightKey) {
        return 1;
      }
      return 0;
    });

// Sites compared as multisets: an identical site found twice (the same
// call building two artifacts) needs two registrations, each with its own
// boot-check decision.
export const compareSiteCounts = (
  found: readonly string[],
  registered: readonly string[],
): { missing: string[]; stale: string[] } => {
  const surplus = (from: readonly string[], against: readonly string[]) => {
    const remaining = new Map<string, number>();
    for (const site of against) {
      remaining.set(site, (remaining.get(site) ?? 0) + 1);
    }
    return from.filter((site) => {
      const left = remaining.get(site) ?? 0;
      remaining.set(site, left - 1);
      return left <= 0;
    });
  };
  return {
    missing: surplus(found, registered),
    stale: surplus(registered, found),
  };
};

// This census intentionally lives beside its scanner. Adding a bundling site
// therefore requires an explicit decision about how the packaged output boots.
export const BUNDLED_CONSUMERS = [
  {
    file: ".github/workflows/ci.yml",
    command:
      'bun build packages/agent-engine/scripts/mcp-canary-server.ts --target=node --outfile="$RUNNER_TEMP/mcp-canary-server.mjs"',
    bootCheck: { type: "ci-job", jobId: "docker-checks" },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --sourcemap=linked --target bun --outdir /app/bundles --public-path /app/ --entry-naming server.js apps/api/src/server.ts",
    bootCheck: { type: "ci-job", jobId: "api-image-smoke" },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles --public-path /app/ --entry-naming collab.js apps/collab/src/index.ts",
    bootCheck: { type: "ci-job", jobId: "api-image-smoke" },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      'bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --splitting --outdir /app/bundles --public-path /app/ --entry-naming "[name].js" --chunk-naming "chunk-[hash].js" apps/api/src/scripts/backfill-case-law-slugs.ts apps/api/scripts/seed-usage-policies.ts apps/api/scripts/replay-provider-events.ts apps/api/src/scripts/better-auth-migration-audit.ts apps/api/src/scripts/better-auth-microsoft-identity-map.ts apps/api/src/scripts/better-auth-17-backfill.ts apps/api/src/scripts/database-census.ts apps/api/src/scripts/better-auth-sign-in-replay.ts apps/api/src/scripts/replay-case-law-source.ts apps/api/src/scripts/review-account.ts apps/api/src/scripts/partner-oauth-client.ts apps/api/src/scripts/replay-tick.ts apps/api/src/scripts/import-cz-us-roster.ts apps/api/src/scripts/eu-completion-tick.ts apps/api/src/scripts/eu-completion-control.ts apps/api/src/scripts/redact-case-law-decision.ts apps/api/src/scripts/case-law-raw-layout.ts apps/api/src/scripts/complete-sk-us-raw.ts apps/api/src/scripts/decision-analysis-candidates.ts apps/api/src/scripts/decision-analysis-input.ts apps/api/src/scripts/decision-analysis-save.ts apps/api/src/scripts/repair-publisher-absent-text.ts apps/api/src/scripts/repair-cz-ns-court.ts apps/api/scripts/classify-citations.ts apps/api/src/scripts/apply-reviewed-citation-labels.ts apps/api/src/scripts/corpus-generation.ts apps/api/src/scripts/corpus-snippet-compare.ts apps/api/src/scripts/image-smoke-model-ingress.ts apps/api/src/scripts/image-smoke.ts',
    bootCheck: {
      type: "docker-run",
      dockerfile: "apps/api/Dockerfile",
      run: "RUN bun --no-env-file /app/image-smoke.js && touch /tmp/image-smoke-ok",
    },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles/runtime/workers --public-path /app/runtime/workers/ --entry-naming sanctions-matcher-worker.js apps/api/src/lib/lists/sanctions/sanctions-matcher-worker.ts",
    bootCheck: {
      type: "none",
      reason:
        "This operator or worker entrypoint is packaged for runtime dispatch and is not booted by CI.",
    },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles/runtime/workers --public-path /app/runtime/workers/ --entry-naming extraction-worker.js --external @firecrawl/anydoc-linux-arm64-musl --external @firecrawl/anydoc-linux-x64-musl apps/api/src/lib/search/extraction-worker.ts",
    bootCheck: {
      type: "none",
      reason:
        "This operator or worker entrypoint is packaged for runtime dispatch and is not booted by CI.",
    },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles/apps/api/src/db --public-path /app/apps/api/src/db/ --entry-naming migrate.js apps/api/src/db/migrate.ts",
    bootCheck: { type: "ci-job", jobId: "api-image-smoke" },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles/runtime/workers --public-path /app/runtime/workers/ --entry-naming ocr-local-worker.js apps/api/src/lib/ocr-local/ocr-local-worker.ts",
    bootCheck: {
      type: "none",
      reason:
        "This operator or worker entrypoint is packaged for runtime dispatch and is not booted by CI.",
    },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles/runtime/workers --public-path /app/runtime/workers/ --entry-naming ocr-searchable-pdf-worker.js apps/api/src/lib/ocr-searchable-pdf-worker.ts",
    bootCheck: {
      type: "none",
      reason:
        "This operator or worker entrypoint is packaged for runtime dispatch and is not booted by CI.",
    },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles/runtime/workers --public-path /app/runtime/workers/ --entry-naming office-evidence-worker.js apps/api/src/lib/files/office-evidence-worker.ts",
    bootCheck: {
      type: "none",
      reason:
        "This operator or worker entrypoint is packaged for runtime dispatch and is not booted by CI.",
    },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --outdir /app/bundles/runtime/workers --public-path /app/runtime/workers/ --entry-naming pdf-worker.js apps/api/src/lib/files/pdf-worker.ts",
    bootCheck: {
      type: "none",
      reason:
        "This operator or worker entrypoint is packaged for runtime dispatch and is not booted by CI.",
    },
  },
  {
    file: "apps/api/Dockerfile",
    command:
      "bun build --define __STELLA_RELEASE__=true --minify --keep-names --target bun --sourcemap=linked --outdir /app/bundles --public-path /app/ --entry-naming document-processing-worker.js apps/api/src/scripts/document-processing-worker.ts",
    bootCheck: { type: "ci-job", jobId: "api-image-smoke" },
  },
  {
    file: "apps/api/package.json",
    command:
      "bun build --target bun --define 'process.env.NODE_ENV=\"production\"' --outdir .cache/server-build --entry-naming=server.js --metafile-md=.cache/server-metafile.md src/server.ts",
    bootCheck: {
      type: "none",
      reason:
        "The analysis build produces a metafile for inspection and is not a shipped artifact.",
    },
  },
  {
    file: "apps/api/scripts/build-mcp-country-filter-fixture.ts",
    command:
      'Bun.build(entrypoints: [ path.resolve( import.meta.dirname, "../../../packages/mcp-apps/src/case-law-results/app.html", ), ])',
    bootCheck: {
      type: "none",
      reason:
        "This generator build produces fixture or browser assets rather than a bootable artifact.",
    },
  },
  {
    file: "apps/api/scripts/build-visual-sandbox.ts",
    command: 'Bun.build(entrypoints: [path.join(root, "browser/runtime.ts")])',
    bootCheck: {
      type: "none",
      reason:
        "This generator build produces fixture or browser assets rather than a bootable artifact.",
    },
  },
  {
    file: "apps/api/scripts/generate-mcp-app-contracts.ts",
    command:
      'Bun.build(entrypoints: [ path.resolve(import.meta.dirname, "../src/mcp/app-browser-contracts.ts"), ])',
    bootCheck: {
      type: "none",
      reason:
        "This generator build produces fixture or browser assets rather than a bootable artifact.",
    },
  },
  {
    file: "apps/collab/package.json",
    command:
      "bun build --target=bun --define 'process.env.NODE_ENV=\"production\"' --packages=external --outfile dist/index.js src/index.ts",
    bootCheck: {
      type: "none",
      reason:
        "This workspace build is not the compiled collaboration artifact shipped by the API image.",
    },
  },
  {
    file: "apps/legal-atlas-runner/package.json",
    command:
      "bun build --target=bun --define 'process.env.NODE_ENV=\"production\"' --define __STELLA_RELEASE__=true --minify --keep-names --sourcemap=external --outdir dist --entry-naming eu-ecj-refetch.js ../api/src/scripts/eu-ecj-refetch.ts",
    bootCheck: {
      type: "none",
      reason:
        "This auxiliary entrypoint is shipped for an operator task and has no standalone boot check.",
    },
  },
  {
    file: "apps/legal-atlas-runner/package.json",
    command:
      "bun build --target=bun --define 'process.env.NODE_ENV=\"production\"' --define __STELLA_RELEASE__=true --minify --keep-names --sourcemap=external --outdir dist --entry-naming index.js src/index.ts",
    bootCheck: {
      type: "docker-run",
      dockerfile: "apps/legal-atlas-runner/Dockerfile",
      run: "RUN bun apps/legal-atlas-runner/dist/index.js smoke",
    },
  },
  {
    file: "apps/visual-preview/Dockerfile",
    command:
      "bun build apps/visual-preview/src/handler.ts --target=node --format=esm --external playwright-core --outfile /app/handler.mjs",
    bootCheck: {
      type: "none",
      reason:
        "The Lambda image packages a handler export rather than a directly bootable program.",
    },
  },
  {
    file: "apps/web/package.json",
    command:
      "bun build --target=bun --outfile=dist/runtime.js --external ./server/server.js src/runtime.ts",
    bootCheck: { type: "ci-job", jobId: "web-image-smoke" },
  },
  {
    file: "docker/audit/Dockerfile",
    command:
      "bun build --target=bun --outdir .audit-build/api apps/api/src/server.ts",
    bootCheck: {
      type: "none",
      reason:
        "The audit image retains this build output for offline inspection and never runs it.",
    },
  },
  {
    file: "packages/agent-engine/scripts/e2e-mcp-canary.ts",
    command:
      'Bun.build(entrypoints: [path.join(import.meta.dir, "mcp-canary-server.ts")])',
    bootCheck: { type: "ci-job", jobId: "docker-checks" },
  },
  {
    file: "packages/mcp-apps/scripts/build-mcp-apps.ts",
    command: "Bun.build(entrypoints: [path.join(appRoot, input)])",
    bootCheck: {
      type: "none",
      reason:
        "This generator emits browser assets rather than a bootable artifact.",
    },
  },
] as const satisfies readonly BundledConsumer[];
