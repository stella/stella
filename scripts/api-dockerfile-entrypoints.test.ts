import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import runnerPackage from "../apps/legal-atlas-runner/package.json" with { type: "json" };

// Bind builder entrypoints and their sidecars to the runner filesystem so
// documented command overrides keep loading after dependency changes.
const dockerfile = readFileSync(
  nodePath.resolve(import.meta.dirname, "../apps/api/Dockerfile"),
  "utf-8",
);

const stage = (name: string): string => {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, "mu"));
  expect(start, name).toBeGreaterThan(-1);
  const rest = dockerfile.slice(start + 1);
  const next = rest.search(/^FROM /mu);
  return next === -1 ? rest : rest.slice(0, next);
};

const logicalInstructions = (body: string): string[] => {
  const instructions: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    current += `${current ? " " : ""}${line.trim()}`;
    if (current.endsWith("\\")) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    if (current) {
      instructions.push(current);
    }
    current = "";
  }
  return instructions;
};

const bundleBuilds = (body: string): string[] =>
  logicalInstructions(body)
    .filter((instruction) => instruction.startsWith("RUN "))
    .flatMap((instruction) =>
      instruction
        .split(/\bbun build\b/u)
        .slice(1)
        .map((invocation) => invocation.split("&&").at(0)?.trim() ?? ""),
    );

const outfileBundles = (body: string): string[] =>
  bundleBuilds(body).filter(
    (bundle) =>
      !/--compile(?:\s|$)/u.test(bundle) &&
      /--outfile(?:=|\s+)\/app\//u.test(bundle),
  );

const builderCopies = () =>
  logicalInstructions(stage("runner")).flatMap((instruction) => {
    const match = /^COPY .*--from=builder (\/\S+) (\/\S+)$/u.exec(instruction);
    const source = match?.at(1);
    const destination = match?.at(2);
    return source && destination ? [{ source, destination }] : [];
  });

const SOURCE_ENTRY = /^apps\/\S+\.[cm]?tsx?$/u;

const buildEntries = (bundle: string): string[] =>
  bundle.split(/\s+/u).filter((token) => SOURCE_ENTRY.test(token));

// One output per entry: a fixed --entry-naming names a single-entry build's
// output, and `[name]` names each entry of a split build by its source file.
const buildOutputs = (bundle: string): string[] => {
  const outfile = /--outfile(?:=|\s+)(\S+)/u.exec(bundle)?.at(1);
  if (outfile) {
    return [outfile];
  }
  const outdir = /--outdir(?:=|\s+)(\S+)/u.exec(bundle)?.at(1);
  // A `[name]` pattern is quoted in the Dockerfile so the shell never globs it.
  const naming = /--entry-naming(?:=|\s+)(\S+)/u
    .exec(bundle)
    ?.at(1)
    ?.replace(/^"(.*)"$/u, "$1");
  if (!outdir || !naming) {
    throw new TypeError(`Bundle needs an explicit output path: ${bundle}`);
  }
  if (!naming.includes("[name]")) {
    return [nodePath.posix.join(outdir, naming)];
  }
  return buildEntries(bundle).map((entry) =>
    nodePath.posix.join(
      outdir,
      naming.replace("[name]", () => nodePath.posix.parse(entry).name),
    ),
  );
};

const buildOutput = (bundle: string): string => {
  const outputs = buildOutputs(bundle);
  const [output] = outputs;
  if (outputs.length !== 1 || output === undefined) {
    throw new TypeError(`Bundle builds ${outputs.length} entries: ${bundle}`);
  }
  return output;
};

const runnerOutputs = (output: string): string[] =>
  builderCopies().flatMap(({ source, destination }) => {
    if (source === output) {
      return [destination];
    }
    if (source.endsWith("/") && output.startsWith(source)) {
      return [nodePath.posix.join(destination, output.slice(source.length))];
    }
    return [];
  });

const buildForOutput = (output: string): string | undefined =>
  bundleBuilds(stage("builder")).find((bundle) =>
    buildOutputs(bundle).some((built) => runnerOutputs(built).includes(output)),
  );

test("the usage policy seed is available at the documented operator path", () => {
  const docs = readFileSync(
    nodePath.resolve(import.meta.dirname, "../docs/self-hosting.md"),
    "utf-8",
  );
  const commands = [
    ...docs.matchAll(
      /^<!-- usage-policy-seed-command -->\n\n```bash\n([\s\S]+?)\n```$/gmu,
    ),
  ];
  expect(commands).toHaveLength(1);
  const command = commands.at(0)?.at(1);
  expect(command).toBeDefined();
  const invocation = logicalInstructions(command ?? "").at(0);
  expect(invocation).toStartWith(
    "docker compose --env-file deploy/selfhost/.env ",
  );
  expect(invocation).toContain(
    "-f docker-compose.selfhost.yml run --rm --no-deps api bun ",
  );
  const output = invocation?.match(/\bbun (\/app\/\S+)/u)?.at(1);
  if (output === undefined) {
    throw new TypeError("Missing documented seed entrypoint");
  }
  expect(buildForOutput(output)).toContain(
    "apps/api/scripts/seed-usage-policies.ts",
  );
  const startup = logicalInstructions(stage("runner")).filter((instruction) =>
    /^(?:CMD|ENTRYPOINT) /u.test(instruction),
  );
  expect(startup.length).toBeGreaterThan(0);
  expect(startup.join(" ")).not.toContain("seed-usage-policies");
});

test("every script bundle and its sidecars reach the runner at the documented path", () => {
  const bundles = bundleBuilds(stage("builder")).filter(
    (bundle) => !/--compile(?:\s|$)/u.test(bundle),
  );
  expect(bundles.length).toBeGreaterThan(0);
  expect(builderCopies()).toContainEqual({
    source: "/app/bundles/",
    destination: "/app/",
  });
  for (const output of bundles.flatMap(buildOutputs)) {
    expect(output).toStartWith("/app/bundles/");
    expect(runnerOutputs(output), output).toEqual([
      output.replace("/app/bundles/", "/app/"),
    ]);
  }
  expect(buildForOutput("/app/apps/api/src/db/migrate.js")).toContain(
    "apps/api/src/db/migrate.ts",
  );
  expect(buildForOutput("/app/runtime/workers/extraction-worker.js")).toContain(
    "apps/api/src/lib/search/extraction-worker.ts",
  );
  expect(buildForOutput("/app/image-smoke-model-ingress.js")).toContain(
    "apps/api/src/scripts/image-smoke-model-ingress.ts",
  );
});

test("no uncompiled /app bundle uses outfile, including chained worker builds", () => {
  expect(outfileBundles(dockerfile)).toEqual([]);
});

test("the outfile guard detects every script bundle when regressed individually", () => {
  // --outfile names one output, so only a single-entry build can regress to it.
  const scripts = bundleBuilds(stage("builder")).filter(
    (bundle) =>
      !/--compile(?:\s|$)/u.test(bundle) && buildOutputs(bundle).length === 1,
  );
  expect(scripts.length).toBeGreaterThan(0);
  for (const bundle of scripts) {
    const output = buildOutput(bundle);
    const regressed = bundle
      .replace(/--outdir(?:=|\s+)\S+/u, () => `--outfile ${output}`)
      .replace(/--entry-naming(?:=|\s+)\S+/u, "");
    expect(regressed, output).not.toBe(bundle);
    // Mutate the normalized instruction, including builds after &&.
    const body = logicalInstructions(stage("builder"))
      .join("\n")
      .replace(bundle, () => regressed);
    expect(outfileBundles(body), output).toEqual([regressed.trim()]);
  }
  expect(
    outfileBundles("RUN bun build --compile --outfile /app/server src.ts"),
  ).toEqual([]);
});

// The runner runs every entrypoint with the base image's Bun; a --compile
// binary would embed another full copy of the runtime in the image.
test("the image ships one Bun runtime: no builder bundle compiles", () => {
  expect(
    bundleBuilds(stage("builder")).filter((bundle) =>
      /--compile(?:\s|$)/u.test(bundle),
    ),
  ).toEqual([]);
});

// Bun emits a `with { type: "file" }` import as "./name-hash.ext" unless the
// build names a public path, and that relative path resolves against the
// process working directory (/app/apps/api), not the bundle. Each bundle must
// therefore name the absolute directory its output occupies on the runner.
test("every bundle resolves its file assets from its runner directory", () => {
  const bundles = bundleBuilds(stage("builder"));
  expect(bundles.length).toBeGreaterThan(0);
  for (const bundle of bundles) {
    const publicPath = /--public-path(?:=|\s+)(\S+)/u.exec(bundle)?.at(1);
    for (const output of buildOutputs(bundle)) {
      const runnerDirectories = runnerOutputs(output).map(
        (runnerOutput) => `${nodePath.posix.dirname(runnerOutput)}/`,
      );
      expect(runnerDirectories, output).toHaveLength(1);
      expect(publicPath, output).toBe(runnerDirectories.at(0));
    }
  }
});

// Operator scripts share most of their code, and a standalone bundle repeats
// all of it: built one by one, the scripts shipped about 125 MB more. The
// long-running services keep their own bundles; every other /app script joins
// the one split build.
const STANDALONE_BUNDLES = [
  "/app/bundles/collab.js",
  "/app/bundles/document-processing-worker.js",
  "/app/bundles/server.js",
];

test("operator scripts build once, sharing their code through chunks", () => {
  const scripts = bundleBuilds(stage("builder")).filter((bundle) =>
    /--outdir(?:=|\s+)\/app\/bundles(?:\s|$)/u.test(bundle),
  );
  const split = scripts.filter((bundle) => /--splitting(?:\s|$)/u.test(bundle));
  expect(split).toHaveLength(1);
  expect(buildOutputs(split.at(0) ?? "").length).toBeGreaterThan(1);
  // The image smoke finds the split scripts by their chunk imports.
  expect(split.at(0)).toContain('--chunk-naming "chunk-[hash].js"');
  expect(
    scripts
      .filter((bundle) => !split.includes(bundle))
      .flatMap(buildOutputs)
      .toSorted(),
    "add a new /app script to the split build instead of its own bun build",
  ).toEqual(STANDALONE_BUNDLES);
});

// Error fingerprints need source positions, so long-running bundles ship a
// linked map beside the bundle. The map's embedded source text is never read
// at runtime, so each build strips it in the same instruction.
const STRIP_SOURCE_MAP = "bun apps/api/scripts/strip-source-map-content.ts";

test("long-running API builds map frames to source without embedded source text", () => {
  const instructions = logicalInstructions(stage("builder"));
  for (const output of [
    "/app/server.js",
    "/app/document-processing-worker.js",
  ]) {
    const bundle = buildForOutput(output);
    expect(bundle, output).toContain("--sourcemap=linked");
    const map = `${buildOutput(bundle ?? "")}.map`;
    expect(runnerOutputs(map), output).toEqual([`${output}.map`]);
    const instruction = instructions.find((candidate) =>
      candidate.includes(bundle ?? "\0"),
    );
    expect(instruction, output).toContain(`&& ${STRIP_SOURCE_MAP} ${map}`);
  }
});

test("no builder bundle embeds an inline source map", () => {
  expect(
    bundleBuilds(stage("builder")).filter((bundle) =>
      /--sourcemap(?:=inline)?(?:\s|$)/u.test(bundle),
    ),
  ).toEqual([]);
});

// The case-law runner is the third long-running bundle that reports errors
// through `captureError`, which keeps the top stack frame and folds it into
// the issue fingerprint. Without a source map those frames are offsets into
// the bundle: they name no source position, and they move whenever a rebuild
// shifts the layout, so one recurring failure splits across as many issues as
// it sees builds. Both image stages and the CI production smoke bundle the
// runner through its own package script, so the flags are asserted there rather
// than at each `bun --filter` call site. The images rename each bundle, so the
// map is external (Bun finds `<bundle>.map` beside it, with no URL comment
// naming the old file) and each image copies it beside the renamed bundle.
const RUNNER_BUNDLES = [
  { dist: "dist/index.js", runner: "/app/legal-atlas.js" },
  { dist: "dist/eu-ecj-refetch.js", runner: "/app/eu-ecj-refetch.js" },
] as const;
const RUNNER_DOCKERFILES = [
  "apps/api/Dockerfile",
  "apps/legal-atlas-runner/Dockerfile",
];

test("the long-running case-law runner build maps frames to source", () => {
  const build = runnerPackage.scripts.build;
  expect(build).not.toMatch(/--sourcemap(?:=inline)?(?:\s|$)/u);
  expect(build.match(/--sourcemap=external/gu)).toHaveLength(
    RUNNER_BUNDLES.length,
  );
  expect(build).toContain(
    `&& bun ../api/scripts/strip-source-map-content.ts ${RUNNER_BUNDLES.map(
      ({ dist }) => `${dist}.map`,
    ).join(" ")}`,
  );
  for (const file of RUNNER_DOCKERFILES) {
    const source = readFileSync(
      nodePath.resolve(import.meta.dirname, "..", file),
      "utf-8",
    );
    for (const { dist, runner } of RUNNER_BUNDLES) {
      expect(source, file).toContain(
        `--from=builder /app/apps/legal-atlas-runner/${dist}.map ${runner}.map\n`,
      );
    }
  }
});

// Bun inlines direct `process.env.NODE_ENV` reads at bundle time, and inlines
// "development" when the variable is unset, so the builder must set it before
// its first bundle. The runner stage setting it too proves nothing here.
const BUNDLE_INSTRUCTION = /\bbun build\b|\bbun --filter \S+ build\b/u;
const RELEASE_DEFINE = "--define __STELLA_RELEASE__=true";

test("the builder stage sets NODE_ENV before its first bundle", () => {
  const instructions = logicalInstructions(stage("builder"));
  const nodeEnv = instructions.indexOf("ENV NODE_ENV=production");
  const firstBundle = instructions.findIndex(
    (instruction) =>
      instruction.startsWith("RUN ") && BUNDLE_INSTRUCTION.test(instruction),
  );
  expect(firstBundle).toBeGreaterThan(-1);
  expect(nodeEnv).toBeGreaterThan(-1);
  expect(nodeEnv).toBeLessThan(firstBundle);
});

// A published artifact refuses local development access at startup only if
// the release flag is compiled into it.
test("every builder bundle is a release build", () => {
  const bundles = bundleBuilds(stage("builder"));
  expect(bundles.length).toBeGreaterThan(0);
  expect(bundles.filter((bundle) => !bundle.includes(RELEASE_DEFINE))).toEqual(
    [],
  );
  expect(runnerPackage.scripts.build).toContain(RELEASE_DEFINE);
});

// A package that loads its native binding by a path relative to its own module
// (`createRequire(import.meta.url)("../index.cjs")`) resolves that path next to
// the bundle once it is bundled or compiled, so the entrypoint crashes at start
// with "Cannot find module ../index.cjs". The bundler follows a static import of
// the loader, so only this relative shape is refused.
const RELATIVE_NATIVE_LOADER =
  /createRequire\(import\.meta\.url\)\(\s*["']\.\.\/index\.cjs["']\s*\)/u;
const REPOSITORY_ROOT = nodePath.resolve(import.meta.dirname, "..");

const bundledEntrypoints = (): string[] => {
  const image = bundleBuilds(stage("builder")).flatMap(buildEntries);
  const runner = runnerPackage.scripts.build
    .split("&&")
    .filter((command) => /\bbun build\b/u.test(command))
    .flatMap((command) =>
      command
        .split(/\s+/u)
        .filter((token) => /\.[cm]?tsx?$/u.test(token))
        .map((token) => nodePath.posix.join("apps/legal-atlas-runner", token)),
    );
  return [...new Set([...image, ...runner])].toSorted();
};

const entrypoints = bundledEntrypoints();

// A scoped install may leave an app's third-party dependency absent. Those
// imports stay external so the graph still builds; every @stll package keeps
// resolving normally, so a missing one still fails the build.
const UNINSTALLED_THIRD_PARTY_EXTERNAL: Bun.BunPlugin = {
  name: "uninstalled-third-party-external",
  setup: (build) => {
    build.onResolve({ filter: /^[^./]/u }, ({ path, importer }) => {
      if (path.startsWith("@stll/") || path.startsWith("@/")) {
        return undefined;
      }
      try {
        Bun.resolveSync(path, nodePath.dirname(importer));
        return undefined;
      } catch {
        return { path, external: true };
      }
    });
  },
};

test("the native-loader guard covers the server and the case-law runner", () => {
  expect(entrypoints).toContain("apps/api/src/server.ts");
  expect(entrypoints).toContain("apps/legal-atlas-runner/src/index.ts");
});

// One build over every entrypoint resolves the shared graph once: per-entry
// builds repeat it dozens of times and starve the checks that share the pool.
let entrypointGraph: Promise<Bun.BuildOutput> | undefined;
const buildEntrypointGraph = async (): Promise<Bun.BuildOutput> => {
  entrypointGraph ??= Bun.build({
    entrypoints: entrypoints.map((entry) =>
      nodePath.join(REPOSITORY_ROOT, entry),
    ),
    target: "bun",
    metafile: true,
    plugins: [UNINSTALLED_THIRD_PARTY_EXTERNAL],
  });
  return await entrypointGraph;
};

test("no bundled entrypoint reaches a package that loads its native binding by a relative path", async () => {
  const result = await buildEntrypointGraph();
  expect(result.success).toBe(true);
  const inputs = Object.entries(result.metafile?.inputs ?? {});
  const relativeLoaders = new Set(
    inputs
      .map(([file]) => file)
      .filter(
        (file) =>
          file.includes("node_modules/") &&
          RELATIVE_NATIVE_LOADER.test(
            readFileSync(nodePath.resolve(file), "utf-8"),
          ),
      ),
  );
  const offenders = inputs.flatMap(([file, input]) =>
    file.includes("node_modules/")
      ? []
      : input.imports
          .filter((imported) => relativeLoaders.has(imported.path))
          .map(
            (imported) =>
              `${file} -> ${imported.path.replace(/^.*node_modules\//u, "")}`,
          ),
  );
  expect(offenders).toEqual([]);
}, 120_000);

// The split build moves a module that several entries import into a shared
// chunk. An entry imported by another module would move there too, and its
// `if (import.meta.main)` block, now in a chunk that is never the main
// module, would never run: the script would exit 0 having done nothing. Code
// another module needs lives in a module of its own, as replay-tick-command.ts.
// timeout: bundles every API entrypoint, which takes tens of seconds on CI
test("no bundled module imports another entrypoint", async () => {
  const result = await buildEntrypointGraph();
  expect(result.success).toBe(true);
  const entries = new Set(
    entrypoints.map((entry) => nodePath.join(REPOSITORY_ROOT, entry)),
  );
  const offenders = Object.entries(result.metafile?.inputs ?? {}).flatMap(
    ([file, input]) =>
      input.imports
        .filter((imported) => entries.has(nodePath.resolve(imported.path)))
        .map((imported) => `${file} -> ${imported.path}`),
  );
  expect(offenders).toEqual([]);
}, 120_000);
