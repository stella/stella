import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { LOCAL_SEED_SCRIPTS } from "../apps/api/scripts/seed-local-scripts";
import { cachedForRepository } from "./ci-repository-cache";
import { GENERATORS } from "./generated-files";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const infrastructurePaths = new Set([
  ".github/workflows/ci.yml",
  "scripts/ci-repository-cache.ts",
  "scripts/detect-service-suite-changes.ts",
  "scripts/detect-service-suite-changes.test.ts",
  "scripts/generated-files.ts",
  "packages/scripts/src/generated-files.ts",
  "scripts/ci-plan.test.ts",
  ".npmrc",
  "scripts/retry.sh",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "scripts/configure-test-postgres.sh",
  "scripts/configure-test-postgres.integration.sh",
]);

const SUITES = {
  postgres: { app: "api" },
  valkey: { app: "api" },
  corpus: { app: "api" },
  collab: { app: "collab" },
} as const;
type ServiceSuite = keyof typeof SUITES;

// Own repository reads and parsing here so the four suite projections share
// the same source inventory.
const repositorySources = new Map<string, string>();
const repositoryImports = new Map<
  string,
  ReturnType<Bun.Transpiler["scanImports"]>
>();
const repositoryGlobs = new Map<string, readonly string[]>();
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });

const sourceText = (root: string, file: string) =>
  cachedForRepository(repositorySources, { root, key: file }, () =>
    readFileSync(path.join(root, file), "utf-8"),
  );

const sourceImports = (root: string, file: string) =>
  cachedForRepository(repositoryImports, { root, key: file }, () => {
    const transpiler =
      file.endsWith("tsx") || file.endsWith("jsx")
        ? tsxTranspiler
        : tsTranspiler;
    return transpiler.scanImports(
      sourceText(root, file).replace(/^#![^\n]*/u, ""),
    );
  });

const globFiles = (root: string, pattern: string) =>
  cachedForRepository(repositoryGlobs, { root, key: pattern }, () => [
    ...new Bun.Glob(pattern).scanSync({ cwd: root }),
  ]);

const CORPUS_ENGINE_TEST_ALLOWLIST = new Map([
  [
    "apps/api/scripts/run-corpus-engine-suites.test.ts",
    "Tests the runner and gate discovery without connecting to the engine.",
  ],
]);
const CORPUS_ENGINE_TEST_ALLOWLIST_CEILING = 1;

const readRunner = (runners: unknown, script: string) => {
  if (typeof runners !== "object" || runners === null) {
    return undefined;
  }
  const runner: unknown = Reflect.get(runners, script);
  if (typeof runner !== "object" || runner === null) {
    return undefined;
  }
  const gate: unknown = Reflect.get(runner, "gate");
  const entrypoint: unknown = Reflect.get(runner, "runner");
  const testFileGlob: unknown = Reflect.get(runner, "testFileGlob");
  if (
    typeof gate !== "string" ||
    gate.length === 0 ||
    typeof entrypoint !== "string" ||
    entrypoint.length === 0 ||
    typeof testFileGlob !== "string" ||
    testFileGlob.length === 0
  ) {
    return undefined;
  }
  return { gate, runner: entrypoint, testFileGlob };
};

// Read metadata only while planning, inside the CLI's guarded path. Importing
// this module must not dereference a runner that a package edit removed.
const loadSuites = (root: string) => {
  const manifest: unknown = JSON.parse(
    sourceText(root, "apps/api/package.json"),
  );
  const runners: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "ciGateTestRunners")
      : undefined;
  const postgres = readRunner(runners, "test:postgres");
  const valkey = readRunner(runners, "test:valkey");
  if (postgres === undefined || valkey === undefined) {
    return {
      status: "unresolved" as const,
      message: "Missing or invalid API service test runner metadata",
    };
  }
  return {
    status: "complete" as const,
    suites: {
      postgres: { ...SUITES.postgres, ...postgres },
      valkey: { ...SUITES.valkey, ...valkey },
      corpus: {
        ...SUITES.corpus,
        gate: "STELLA_RUN_CORPUS_ENGINE_TESTS",
        runner: "",
        testFileGlob: "src/**/*.test.ts",
      },
      collab: { ...SUITES.collab, gate: "", runner: "", testFileGlob: "" },
    },
  };
};

const directlyRequired = (file: string, suite: ServiceSuite) => {
  if (
    infrastructurePaths.has(file) ||
    file.startsWith("patches/") ||
    file.startsWith("docker/postgres/")
  ) {
    return true;
  }
  const { app } = SUITES[suite];
  if (
    [
      `apps/${app}/package.json`,
      `apps/${app}/tsconfig.json`,
      `apps/${app}/bunfig.toml`,
    ].includes(file) ||
    file.startsWith(`apps/${app}/scripts/`) ||
    file.startsWith(`apps/${app}/src/tests/`)
  ) {
    return true;
  }
  if (app === "collab") {
    return file.startsWith("apps/collab/src/");
  }
  // Preserve deletion and runtime-asset coverage where the current checkout
  // cannot recover a removed gate or an fs/Glob dependency.
  if (
    file.startsWith("apps/api/src/") &&
    (!/\.[cm]?[jt]sx?$/u.test(file) || file.includes("/__fixtures__/"))
  ) {
    return true;
  }
  if (suite === "valkey") {
    return file.startsWith("apps/api/src/") && /\.test\.[jt]sx?$/u.test(file);
  }
  return (
    file.startsWith("apps/api/src/scripts/") ||
    file.startsWith("apps/api/drizzle/") ||
    file.startsWith("apps/api/src/db/") ||
    file.startsWith("apps/api/src/lib/db/") ||
    file.startsWith("apps/api/src/lib/scheduler/") ||
    (file.startsWith("apps/api/src/") &&
      (file.includes("backfill") || /\.test\.[jt]sx?$/u.test(file)))
  );
};

// A derived module is never committed: it exists only once its generator runs,
// so the generator's declared inputs stand in for it in the import graph.
// Keyed by plain paths: lookups come from arbitrary import specifiers.
const DERIVED_OUTPUT_INPUTS: ReadonlyMap<string, readonly string[]> = new Map(
  GENERATORS.filter(({ outputKind }) => outputKind === "derived").flatMap(
    ({ outputs, inputs }) => outputs.map((output) => [output, inputs] as const),
  ),
);

const DERIVED_OUTPUT_GLOBS = GENERATORS.filter(
  ({ outputKind }) => outputKind === "derived",
).flatMap(({ outputs, inputs }) =>
  outputs
    .filter((output) => /[*?[{]/u.test(output))
    .map((output) => ({ glob: new Bun.Glob(output), inputs })),
);

const derivedInputFiles = (inputs: readonly string[], root: string) =>
  inputs.flatMap((input) =>
    /[*?[{]/u.test(input)
      ? [...new Bun.Glob(input).scanSync({ cwd: root, onlyFiles: true })]
      : [input],
  );

/**
 * The repository files a local import stands for, or undefined when it names
 * nothing. A derived output maps to its generator inputs whether or not a
 * local run already generated it.
 */
const resolveLocalImport = (
  candidate: string,
  root: string,
): readonly string[] | undefined => {
  const stem = candidate.replace(/\.[cm]?jsx?$/u, "");
  const derivedInputs = [candidate, `${stem}.ts`]
    .map((entry) => DERIVED_OUTPUT_INPUTS.get(entry))
    .find((inputs) => inputs !== undefined);
  if (derivedInputs !== undefined) {
    return derivedInputFiles(derivedInputs, root);
  }
  const derivedGlob = DERIVED_OUTPUT_GLOBS.find(({ glob }) =>
    [candidate, `${stem}.ts`].some((entry) => glob.match(entry)),
  );
  if (derivedGlob !== undefined) {
    return derivedInputFiles(derivedGlob.inputs, root);
  }
  const resolved = [
    candidate,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`,
  ].find(
    (entry) =>
      existsSync(path.join(root, entry)) &&
      statSync(path.join(root, entry)).isFile(),
  );
  return resolved === undefined ? undefined : [resolved];
};

// `@stll/<name>/subpath` → `<name>`.
const workspacePackageName = (specifier: string): string =>
  specifier.slice("@stll/".length).split("/", 1)[0] ?? "";

const expandWorkspaceScopes = (packageScopes: Set<string>, root: string) => {
  // Referenced packages are units; follow their declared workspace dependencies
  // without parsing their sources or relying on installed workspace symlinks.
  const pendingPackages = [...packageScopes];
  for (const scope of pendingPackages) {
    const manifest: unknown = JSON.parse(
      sourceText(root, path.posix.join(scope, "package.json")),
    );
    if (typeof manifest !== "object" || manifest === null) {
      return `Invalid manifest: ${scope}`;
    }
    for (const [kind, values] of Object.entries(manifest)) {
      if (
        !["dependencies", "peerDependencies", "optionalDependencies"].includes(
          kind,
        ) ||
        typeof values !== "object" ||
        values === null
      ) {
        continue;
      }
      for (const dependency of Object.keys(values)) {
        if (!dependency.startsWith("@stll/")) {
          continue;
        }
        const dependencyScope = `packages/${dependency.slice("@stll/".length)}/`;
        if (
          packageScopes.has(dependencyScope) ||
          !existsSync(path.join(root, dependencyScope, "package.json"))
        ) {
          continue;
        }
        packageScopes.add(dependencyScope);
        pendingPackages.push(dependencyScope);
      }
    }
  }
  return undefined;
};

type LocalImportWalkOptions = {
  root: string;
  pending: string[];
  dependencies: Set<string>;
  packageScopes: Set<string>;
};

// Follows local imports from `pending` file by file and records the workspace
// packages they reach as units. Returns why an import cannot be resolved.
const walkLocalImports = ({
  root,
  pending,
  dependencies,
  packageScopes,
}: LocalImportWalkOptions) => {
  for (const file of pending) {
    if (dependencies.has(file)) {
      continue;
    }
    dependencies.add(file);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    for (const { path: specifier } of sourceImports(root, file)) {
      if (specifier.startsWith("@stll/")) {
        const name = workspacePackageName(specifier);
        const scope = `packages/${name}/`;
        if (packageScopes.has(scope)) {
          continue;
        }
        if (!existsSync(path.join(root, scope, "package.json"))) {
          // Published @stll packages are dependency inputs, covered by bun.lock.
          continue;
        }
        packageScopes.add(scope);
        continue;
      }
      let candidate: string;
      if (specifier.startsWith("@/api/")) {
        candidate = `apps/api/src/${specifier.slice("@/api/".length)}`;
      } else if (specifier.startsWith(".")) {
        candidate = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier),
        );
      } else {
        continue;
      }
      const resolved = resolveLocalImport(candidate, root);
      if (resolved === undefined) {
        return `Unresolved service-suite import: ${file}: ${specifier}`;
      }
      pending.push(...resolved);
    }
  }
  return undefined;
};

/** Workspace packages are scoped as units, including exports and non-code assets.
 * Local API/collaboration imports are followed file by file. No install is needed
 * in ci-plan: package discovery uses the checkout, not node_modules.
 */
export const serviceSuiteDependencies = (
  root = repositoryRoot,
  suite?: ServiceSuite,
) => {
  const configuration = loadSuites(root);
  if (configuration.status === "unresolved") {
    return configuration;
  }
  const suites = configuration.suites;
  const dependencies = new Set<string>();
  const selected =
    suite === undefined ? Object.values(suites) : [suites[suite]];
  const apps = new Set(selected.map(({ app }) => app));
  const pending: string[] = [];
  if (apps.has("collab")) {
    pending.push("apps/collab/src/server.test.ts");
  }
  if (apps.has("api")) {
    pending.push("apps/api/src/tests/setup-env.ts");
  }
  if (
    selected.some(
      ({ gate }) =>
        gate === suites.postgres.gate || gate === suites.corpus.gate,
    )
  ) {
    pending.push("apps/api/src/db/migrate.ts");
  }
  for (const { app, runner } of selected) {
    if (runner !== "") {
      pending.push(`apps/${app}/${runner}`);
    }
  }
  const packageScopes = new Set<string>();
  if (apps.has("api")) {
    const testGlobs = new Set([
      ...selected
        .filter(({ app }) => app === "api")
        .map(({ testFileGlob }) => `apps/api/${testFileGlob}`),
    ]);
    const testFiles = new Set<string>();
    for (const glob of testGlobs) {
      for (const file of globFiles(root, glob)) {
        testFiles.add(file);
      }
    }
    for (const file of testFiles) {
      const source = sourceText(root, file);
      if (selected.some(({ gate }) => gate !== "" && source.includes(gate))) {
        pending.push(file);
      }
    }
  }
  const walkError =
    walkLocalImports({ root, pending, dependencies, packageScopes }) ??
    expandWorkspaceScopes(packageScopes, root);
  if (walkError !== undefined) {
    return { status: "unresolved" as const, message: walkError };
  }
  for (const scope of packageScopes) {
    dependencies.add(`${scope}package.json`);
  }
  // Configuration and runner harnesses can change execution without an import.
  for (const app of apps) {
    for (const file of globFiles(
      root,
      `apps/${app}/{package.json,bunfig.toml,tsconfig.json,scripts/**,src/tests/**}`,
    )) {
      dependencies.add(file);
    }
  }
  return { status: "complete" as const, dependencies, packageScopes };
};

// `bun run agent:up` migrates its database with the committed migrations, then
// runs db:seed-local, which spawns each of its scripts by file name.
const DEV_SEED_ENTRY_POINTS = [
  "apps/api/src/db/migrate.ts",
  "apps/api/scripts/seed-local.ts",
  ...LOCAL_SEED_SCRIPTS.map((script) => `apps/api/scripts/${script}`),
];

// What the seed reads without importing it: the migrations, its fixtures, the
// environment template CI seeds with, and any non-code API source asset.
const devSeedDirectlyRequired = (file: string) =>
  infrastructurePaths.has(file) ||
  file.startsWith("patches/") ||
  file.startsWith("docker/postgres/") ||
  [
    "apps/api/package.json",
    "apps/api/tsconfig.json",
    "apps/api/bunfig.toml",
    "apps/api/.env.example",
  ].includes(file) ||
  file.startsWith("apps/api/drizzle/") ||
  file.startsWith("apps/api/scripts/__fixtures__/") ||
  (file.startsWith("apps/api/src/") && !/\.[cm]?[jt]sx?$/u.test(file));

/** The files `db:seed-local` runs on a freshly migrated database. */
export const devSeedDependencies = (root = repositoryRoot) => {
  const missing = DEV_SEED_ENTRY_POINTS.find(
    (file) => !existsSync(path.join(root, file)),
  );
  if (missing !== undefined) {
    return {
      status: "unresolved" as const,
      message: `Missing dev seed entry point: ${missing}`,
    };
  }
  const dependencies = new Set<string>();
  const packageScopes = new Set<string>();
  const walkError =
    walkLocalImports({
      root,
      pending: [...DEV_SEED_ENTRY_POINTS],
      dependencies,
      packageScopes,
    }) ?? expandWorkspaceScopes(packageScopes, root);
  if (walkError !== undefined) {
    return { status: "unresolved" as const, message: walkError };
  }
  return { status: "complete" as const, dependencies, packageScopes };
};

type DependencyGraph =
  | ReturnType<typeof serviceSuiteDependencies>
  | ReturnType<typeof devSeedDependencies>;

// An unreadable graph cannot prove a change outside it.
const graphSelects = (
  graph: DependencyGraph,
  files: readonly string[],
): boolean => {
  if (graph.status === "unresolved") {
    console.error(graph.message);
    return true;
  }
  return files.some(
    (file) =>
      graph.dependencies.has(file) ||
      [...graph.packageScopes].some((scope) => file.startsWith(scope)),
  );
};

const suiteGraphs = new Map<
  string,
  ReturnType<typeof serviceSuiteDependencies>
>();
const devSeedGraphs = new Map<string, ReturnType<typeof devSeedDependencies>>();
const suiteConfigurations = new Map<string, ReturnType<typeof loadSuites>>();

const suiteConfiguration = (root: string) =>
  cachedForRepository(suiteConfigurations, { root, key: root }, () =>
    loadSuites(root),
  );

type ServiceSuitePlan = Record<ServiceSuite | "devSeed", boolean>;

export const planServiceSuites = (
  files: readonly string[],
  root = repositoryRoot,
): ServiceSuitePlan => {
  const configuration = suiteConfiguration(root);
  if (configuration.status === "unresolved") {
    console.error(configuration.message);
    return {
      postgres: true,
      corpus: true,
      valkey: true,
      collab: true,
      devSeed: true,
    };
  }
  const required = (suite: ServiceSuite): boolean =>
    files.some((file) => directlyRequired(file, suite)) ||
    graphSelects(
      cachedForRepository(suiteGraphs, { root, key: suite }, () =>
        serviceSuiteDependencies(root, suite),
      ),
      files,
    );
  const devSeed =
    files.some(devSeedDirectlyRequired) ||
    graphSelects(
      cachedForRepository(devSeedGraphs, { root, key: root }, () =>
        devSeedDependencies(root),
      ),
      files,
    );
  return {
    // The dev seed runs in the Postgres service job, so it selects that job.
    postgres: devSeed || required("postgres"),
    corpus: required("corpus"),
    valkey: required("valkey"),
    collab: required("collab"),
    devSeed,
  };
};

export const requiresServiceSuites = (
  files: readonly string[],
  root = repositoryRoot,
) => Object.values(planServiceSuites(files, root)).some(Boolean);

export const corpusEngineScopeViolations = (root = repositoryRoot) => {
  const graph = serviceSuiteDependencies(root, "corpus");
  if (graph.status === "unresolved") {
    return [graph.message];
  }
  const candidates = [
    ...new Bun.Glob("apps/api/**/*.test.{ts,tsx}").scanSync({ cwd: root }),
  ].filter((file) =>
    readFileSync(path.join(root, file), "utf-8").includes(
      "STELLA_RUN_CORPUS_ENGINE_TESTS",
    ),
  );
  const candidateSet = new Set(candidates);
  const staleAllowlist = [...CORPUS_ENGINE_TEST_ALLOWLIST].filter(
    ([file, reason]) => !candidateSet.has(file) || reason.trim().length === 0,
  );
  const outsideScope = candidates.filter(
    (file) =>
      !CORPUS_ENGINE_TEST_ALLOWLIST.has(file) && !graph.dependencies.has(file),
  );
  return [
    ...(CORPUS_ENGINE_TEST_ALLOWLIST.size > CORPUS_ENGINE_TEST_ALLOWLIST_CEILING
      ? ["Corpus engine census allowlist may only shrink"]
      : []),
    ...outsideScope.map(
      (file) => `${file}: engine test is outside the corpus scope`,
    ),
    ...staleAllowlist.map(
      ([file]) =>
        `${file}: stale or unreasoned corpus engine census allowlist entry`,
    ),
  ];
};

/** The line the CLI prints for its arguments; ci-plan reads it. */
export const serviceSuiteCliOutput = (args: readonly string[]): string => {
  const scopes = args.at(0) === "--scopes";
  const files = args.slice(scopes ? 1 : 0);
  // A missing/deleted dependency or an unreadable graph must widen the scope.
  try {
    const plan = planServiceSuites(files);
    return scopes
      ? [plan.postgres, plan.corpus, plan.valkey, plan.collab].join(" ")
      : String(Object.values(plan).some(Boolean));
  } catch (error) {
    console.error(error);
    return scopes ? "true true true true" : "true";
  }
};

if (import.meta.main) {
  console.log(serviceSuiteCliOutput(process.argv.slice(2)));
}
