import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import runnerPackage from "../apps/legal-atlas-runner/package.json" with { type: "json" };

// Every operator entrypoint the builder stage bundles under /app must be
// copied into the runner stage by the same name, or the documented command
// override fails with module-not-found on the deployed image. The two lists
// live sixty lines apart in the same file, so they are bound here rather than
// by reading both on every change.
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

const buildForOutput = (output: string): string | undefined =>
  logicalInstructions(stage("builder")).find(
    (instruction) =>
      instruction.startsWith("RUN bun build ") &&
      instruction.includes(`--outfile ${output} `),
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
  expect(stage("runner")).toContain(
    `COPY --chown=stella:stella --from=builder ${output} ${output}`,
  );
  const startup = logicalInstructions(stage("runner")).filter((instruction) =>
    /^(?:CMD|ENTRYPOINT) /u.test(instruction),
  );
  expect(startup.length).toBeGreaterThan(0);
  expect(startup.join(" ")).not.toContain("seed-usage-policies");
});

test("every bundled /app entrypoint reaches the runner stage", () => {
  const built = [
    ...stage("builder").matchAll(/--outfile \/app\/([\w.-]+\.js)/gu),
  ]
    .map((match) => match[1] ?? "")
    .toSorted();
  expect(built.length).toBeGreaterThan(0);
  const copied = new Set(
    [
      ...stage("runner").matchAll(
        /--from=builder \/app\/([\w.-]+\.js) \/app\/\1/gu,
      ),
    ].map((match) => match[1] ?? ""),
  );
  expect(built.filter((name) => !copied.has(name))).toEqual([]);
});

test("long-running API builds map frames to source", () => {
  for (const output of [
    "/app/server",
    "/app/document-processing-worker.js",
    "/app/file-derivative-worker.js",
  ]) {
    expect(buildForOutput(output), output).toContain("--sourcemap=inline");
  }
});

// The case-law runner is the third long-running bundle that reports errors
// through `captureError`, which keeps the top stack frame and folds it into
// the issue fingerprint. Without a source map those frames are offsets into
// the bundle: they name no source position, and they move whenever a rebuild
// shifts the layout, so one recurring failure splits across as many issues as
// it sees builds. Both image stages and the CI production smoke bundle the
// runner through its own package script, so the flag is asserted there rather
// than at each `bun --filter` call site.
test("the long-running case-law runner build maps frames to source", () => {
  expect(runnerPackage.scripts.build).toContain("--sourcemap=inline");
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
  const bundles = logicalInstructions(stage("builder"))
    .filter((instruction) => instruction.startsWith("RUN "))
    .flatMap((instruction) =>
      instruction
        .split(/\bbun build\b/u)
        .slice(1)
        .map((invocation) => invocation.split("&&").at(0) ?? ""),
    );
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
const SOURCE_ENTRY = /^apps\/\S+\.[cm]?tsx?$/u;

const bundledEntrypoints = (): string[] => {
  const image = logicalInstructions(stage("builder"))
    .filter((instruction) => instruction.startsWith("RUN "))
    .flatMap((instruction) =>
      instruction
        .split(/\bbun build\b/u)
        .slice(1)
        .flatMap((invocation) =>
          (invocation.split("&&").at(0) ?? "")
            .split(/\s+/u)
            .filter((token) => SOURCE_ENTRY.test(token)),
        ),
    );
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
test("no bundled entrypoint reaches a package that loads its native binding by a relative path", async () => {
  const result = await Bun.build({
    entrypoints: entrypoints.map((entry) =>
      nodePath.join(REPOSITORY_ROOT, entry),
    ),
    target: "bun",
    metafile: true,
    plugins: [UNINSTALLED_THIRD_PARTY_EXTERNAL],
  });
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
