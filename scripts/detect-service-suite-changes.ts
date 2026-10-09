import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { GENERATORS } from "./generated-files";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const infrastructurePaths = new Set([
  ".github/workflows/ci.yml",
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
    readFileSync(path.join(root, "apps/api/package.json"), "utf-8"),
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
      readFileSync(path.join(root, scope, "package.json"), "utf-8"),
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
      for (const file of new Bun.Glob(glob).scanSync({ cwd: root })) {
        testFiles.add(file);
      }
    }
    for (const file of testFiles) {
      const source = readFileSync(path.join(root, file), "utf-8");
      if (selected.some(({ gate }) => gate !== "" && source.includes(gate))) {
        pending.push(file);
      }
    }
  }
  const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
  const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
  for (const file of pending) {
    if (dependencies.has(file)) {
      continue;
    }
    dependencies.add(file);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    const transpiler =
      file.endsWith("tsx") || file.endsWith("jsx")
        ? tsxTranspiler
        : tsTranspiler;
    for (const { path: specifier } of transpiler.scanImports(
      source.replace(/^#![^\n]*/u, ""),
    )) {
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
        return {
          status: "unresolved" as const,
          message: `Unresolved service-suite import: ${file}: ${specifier}`,
        };
      }
      pending.push(...resolved);
    }
  }
  const packageError = expandWorkspaceScopes(packageScopes, root);
  if (packageError !== undefined) {
    return { status: "unresolved" as const, message: packageError };
  }
  for (const scope of packageScopes) {
    dependencies.add(`${scope}package.json`);
  }
  // Configuration and runner harnesses can change execution without an import.
  for (const app of apps) {
    for (const file of new Bun.Glob(
      `apps/${app}/{package.json,bunfig.toml,tsconfig.json,scripts/**,src/tests/**}`,
    ).scanSync({ cwd: root })) {
      dependencies.add(file);
    }
  }
  return { status: "complete" as const, dependencies, packageScopes };
};

const defaultGraphs = new Map<
  ServiceSuite,
  ReturnType<typeof serviceSuiteDependencies>
>();

export const planServiceSuites = (
  files: readonly string[],
  root = repositoryRoot,
) => {
  const configuration = loadSuites(root);
  if (configuration.status === "unresolved") {
    console.error(configuration.message);
    return { postgres: true, corpus: true, valkey: true, collab: true };
  }
  const required = (suite: ServiceSuite): boolean => {
    if (files.some((file) => directlyRequired(file, suite))) {
      return true;
    }
    if (
      !files.some(
        (file) =>
          file.startsWith(`apps/${SUITES[suite].app}/`) ||
          file.startsWith("packages/"),
      )
    ) {
      return false;
    }
    let graph = root === repositoryRoot ? defaultGraphs.get(suite) : undefined;
    if (graph === undefined) {
      graph = serviceSuiteDependencies(root, suite);
      if (root === repositoryRoot) {
        defaultGraphs.set(suite, graph);
      }
    }
    let selected: boolean;
    switch (graph.status) {
      case "unresolved":
        console.error(graph.message);
        selected = true;
        break;
      case "complete":
        selected = files.some(
          (file) =>
            graph.dependencies.has(file) ||
            [...graph.packageScopes].some((scope) => file.startsWith(scope)),
        );
        break;
    }
    return selected;
  };
  return {
    postgres: required("postgres"),
    corpus: required("corpus"),
    valkey: required("valkey"),
    collab: required("collab"),
  } as const satisfies Record<ServiceSuite, boolean>;
};

export const requiresServiceSuites = (
  files: readonly string[],
  root = repositoryRoot,
) => Object.values(planServiceSuites(files, root)).some(Boolean);

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
