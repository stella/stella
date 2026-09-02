#!/usr/bin/env bun

// Typecheck coverage guard.
//
// A TypeScript file can run through Bun, Vite, Expo, or another loader without
// belonging to any project that CI typechecks. `tsc --listFilesOnly` is the
// compiler's source of truth for project membership, so this guard unions that
// output across every CI typecheck project and rejects repository .ts/.tsx
// files that are absent from the union.
//
// Oxlint fixtures are the sole explicit exemption because many contain
// intentionally invalid source patterns that the rules must detect.
//
// Usage:
//   bun scripts/typecheck-coverage.ts
//   bun scripts/typecheck-coverage.ts --self-test

import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const TSC_NATIVE = "packages/scripts/src/tsc-native.ts";
const WORKSPACE_PARENTS = ["apps", "packages"] as const;
const EXEMPT_PREFIXES = [".oxlint-plugins/__fixtures__/"] as const;
const CONVENTIONAL_TSCONFIG = "tsconfig.json";
const ROOT_TSCONFIG = "tsconfig.json";
const TURBO_CONFIG = "turbo.json";
const TYPECHECK_CACHE_OUTPUTS = [
  ".cache/tsbuildinfo*.json",
  "**/.cache/tsbuildinfo*.json",
] as const;
// Astro remains on its isolated TypeScript 6 checker. It does not invoke the
// native compiler or produce a build-info file for Turbo to restore.
const INCREMENTAL_EXEMPT_PROJECTS = new Set(["apps/landing/tsconfig.json"]);
// apps/web/public contains intentionally untyped static browser assets outside
// the combined Oxc target.
const OXC_DISCOVERY_EXEMPT_PREFIXES = ["apps/web/public/"] as const;
const PROJECT_ARGUMENT =
  /(?:^|\s)(?:-p|--project)(?:\s+|=)(["']?)([^\s"';&]+)\1/gu;

type OxcProjectProxy = {
  config: string;
  target: string;
};

type ProjectBuildInfo = {
  buildInfoFile: string;
  project: string;
};

// Oxc discovers only tsconfig.json files while walking up from a source file.
// Keep every proxy beside the source subtree that its nonstandard native project
// covers. Root-only projects have no source subtree suitable for a proxy.
const OXC_PROJECT_PROXIES = [
  {
    config: "apps/api/contracts/tsconfig.json",
    target: "apps/api/tsconfig.contracts.json",
  },
  {
    config: "apps/api/scripts/tsconfig.json",
    target: "apps/api/tsconfig.scripts.json",
  },
  {
    config: "apps/api/evals/tsconfig.json",
    target: "apps/api/tsconfig.scripts.json",
  },
  {
    config: "apps/api/src/mcp/apps/tsconfig.json",
    target: "apps/api/tsconfig.mcp-apps.json",
  },
  {
    config: "apps/desktop/tests/tsconfig.json",
    target: "apps/desktop/tsconfig.test.json",
  },
  {
    config: "apps/mobile/scripts/tsconfig.json",
    target: "apps/mobile/tsconfig.scripts.json",
  },
  {
    config: "apps/web/scripts/tsconfig.json",
    target: "tsconfig.tooling.json",
  },
  {
    config: "packages/catalogue/scripts/tsconfig.json",
    target: "tsconfig.tooling.json",
  },
  {
    config: "packages/skills/scripts/tsconfig.json",
    target: "tsconfig.tooling.json",
  },
  {
    config: "packages/template-packs/scripts/tsconfig.json",
    target: "tsconfig.tooling.json",
  },
] as const satisfies readonly OxcProjectProxy[];

const OXC_NATIVE_ONLY_PROJECTS = [
  "tsconfig.scripts.json",
  "tsconfig.tooling.json",
  "tsconfig.oxlint-plugins.json",
] as const;

type Options = {
  selfTest: boolean;
};

const parseArgs = (args: string[]): Options => {
  let selfTest = false;

  for (const argument of args) {
    if (argument === "--self-test") {
      selfTest = true;
      continue;
    }
    panic(`Unknown argument: ${argument}`);
  }

  return { selfTest };
};

const normalizeRepoPath = (file: string): string =>
  file.split(path.sep).join("/");

const isTypeScriptFile = (file: string): boolean => /\.tsx?$/u.test(file);

const isOxcSourceFile = (file: string): boolean =>
  /\.(?:tsx?|jsx?)$/u.test(file);

const isOxcDiscoveryExempt = (file: string): boolean =>
  OXC_DISCOVERY_EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix));

const isConventionalProject = (project: string): boolean =>
  path.posix.basename(project) === CONVENTIONAL_TSCONFIG;

const isExempt = (file: string): boolean =>
  EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix));

const run = (command: string[]): string => {
  const result = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `Command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr.toString()}${result.stdout.toString()}`,
    );
  }
  return result.stdout.toString();
};

const lines = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const supplementalProjects = (typecheckCommand: string): string[] => {
  const projects: string[] = [];
  for (const match of typecheckCommand.matchAll(PROJECT_ARGUMENT)) {
    const project = match[2];
    if (project) {
      projects.push(project);
    }
  }
  return projects;
};

const typecheckProjects = (): string[] => {
  const projects = new Set<string>();

  const addProject = (project: string, owner: string): void => {
    const normalized = normalizeRepoPath(project);
    if (!existsSync(path.join(REPO_ROOT, normalized))) {
      panic(`${owner}'s typecheck script references missing ${project}`);
    }
    projects.add(normalized);
  };

  for (const parent of WORKSPACE_PARENTS) {
    const parentPath = path.join(REPO_ROOT, parent);
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const workspace = path.join(parent, entry.name);
      const packagePath = path.join(REPO_ROOT, workspace, "package.json");
      if (!existsSync(packagePath)) {
        continue;
      }

      const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
      const typecheck = packageJson.scripts?.typecheck;
      if (typeof typecheck !== "string") {
        continue;
      }

      addProject(path.join(workspace, "tsconfig.json"), workspace);

      for (const project of supplementalProjects(typecheck)) {
        addProject(path.join(workspace, project), workspace);
      }
    }
  }

  const rootPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
  );
  const repositoryTypecheck = rootPackage.scripts?.["typecheck:repo"];
  if (typeof repositoryTypecheck !== "string") {
    panic("root package.json must define the typecheck:repo script");
  }
  for (const project of supplementalProjects(repositoryTypecheck)) {
    addProject(project, "typecheck:repo");
  }

  return [...projects].sort();
};

const projectAccountingErrors = (
  projects: string[],
  proxies: readonly OxcProjectProxy[],
  nativeOnlyProjects: readonly string[],
): string[] => {
  const nonstandardProjects = new Set(
    projects.filter((project) => !isConventionalProject(project)),
  );
  const accountedProjects = new Set(nativeOnlyProjects);
  const errors: string[] = [];

  for (const { config, target } of proxies) {
    if (!isConventionalProject(config)) {
      errors.push(`Oxc proxy ${config} is not named ${CONVENTIONAL_TSCONFIG}`);
    }
    accountedProjects.add(target);
    if (!nonstandardProjects.has(target)) {
      errors.push(
        `Oxc proxy ${config} targets ${target}, which is not a nonstandard CI typecheck project`,
      );
    }
  }

  for (const project of nativeOnlyProjects) {
    if (!nonstandardProjects.has(project)) {
      errors.push(
        `Oxc native-only project ${project} is not a nonstandard CI typecheck project`,
      );
    }
  }

  for (const project of nonstandardProjects) {
    if (!accountedProjects.has(project)) {
      errors.push(
        `nonstandard CI typecheck project ${project} has no Oxc proxy or native-only entry`,
      );
    }
  }

  return errors;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readJsonObject = (file: string): Record<string, unknown> => {
  const parsed = Bun.JSONC.parse(readFileSync(file, "utf-8"));
  if (!isRecord(parsed)) {
    panic(
      `${normalizeRepoPath(path.relative(REPO_ROOT, file))} must contain an object`,
    );
  }
  return parsed;
};

const readCompilerOptions = (project: string): ts.CompilerOptions => {
  const configFile = path.join(REPO_ROOT, project);
  const read = ts.readConfigFile(configFile, (file) => ts.sys.readFile(file));
  if (read.error) {
    panic(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configFile),
    undefined,
    configFile,
  );
  if (parsed.errors.length > 0) {
    panic(
      `${project} is invalid:\n${parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n")}`,
    );
  }
  return parsed.options;
};

const duplicateBuildInfoErrors = (projects: ProjectBuildInfo[]): string[] => {
  const owners = new Map<string, string>();
  const errors: string[] = [];
  for (const { buildInfoFile, project } of projects) {
    const owner = owners.get(buildInfoFile);
    if (owner) {
      errors.push(
        `${project} and ${owner} share ${normalizeRepoPath(path.relative(REPO_ROOT, buildInfoFile))}`,
      );
      continue;
    }
    owners.set(buildInfoFile, project);
  }
  return errors;
};

const incrementalProjectErrors = (projects: string[]): string[] => {
  const buildInfoFiles: ProjectBuildInfo[] = [];
  const errors: string[] = [];
  for (const project of projects) {
    if (INCREMENTAL_EXEMPT_PROJECTS.has(project)) {
      continue;
    }
    const options = readCompilerOptions(project);
    if (options.incremental !== true) {
      errors.push(`${project} must enable incremental compilation`);
      continue;
    }

    const buildInfoFile = options.tsBuildInfoFile;
    if (typeof buildInfoFile !== "string") {
      errors.push(`${project} must set tsBuildInfoFile to a string path`);
      continue;
    }
    const relativeBuildInfo = normalizeRepoPath(
      path.relative(REPO_ROOT, buildInfoFile),
    );
    if (!/(?:^|\/)\.cache\/tsbuildinfo[^/]*\.json$/u.test(relativeBuildInfo)) {
      errors.push(
        `${project} stores incremental state outside a .cache/tsbuildinfo*.json path: ${relativeBuildInfo}`,
      );
    }
    buildInfoFiles.push({ buildInfoFile, project });
  }
  errors.push(...duplicateBuildInfoErrors(buildInfoFiles));
  return errors;
};

const turboTypecheckOutputErrors = (): string[] => {
  const turbo = readJsonObject(path.join(REPO_ROOT, TURBO_CONFIG));
  const tasks = turbo["tasks"];
  const typecheck = isRecord(tasks) ? tasks["typecheck"] : undefined;
  const outputs = isRecord(typecheck) ? typecheck["outputs"] : undefined;
  if (
    !Array.isArray(outputs) ||
    !outputs.every((entry) => typeof entry === "string")
  ) {
    return [`${TURBO_CONFIG} typecheck.outputs must be a string array`];
  }

  const expected = new Set<string>(TYPECHECK_CACHE_OUTPUTS);
  const actual = new Set(outputs);
  const errors: string[] = [];
  for (const output of expected) {
    if (!actual.has(output)) {
      errors.push(`${TURBO_CONFIG} typecheck.outputs is missing ${output}`);
    }
  }
  for (const output of actual) {
    if (!expected.has(output)) {
      errors.push(`${TURBO_CONFIG} typecheck.outputs has unexpected ${output}`);
    }
  }
  return errors;
};

const assertIncrementalProjectConfigs = (projects: string[]): void => {
  const errors = [
    ...incrementalProjectErrors(projects),
    ...turboTypecheckOutputErrors(),
  ];
  assert(
    errors.length === 0,
    `TypeScript incremental configuration failed:\n${errors.join("\n")}`,
  );
};

const assertRootConfigIsEmpty = (): void => {
  const rootConfig = readJsonObject(path.join(REPO_ROOT, ROOT_TSCONFIG));
  const files = rootConfig["files"];
  assert(
    Array.isArray(files) && files.length === 0,
    `${ROOT_TSCONFIG} must set "files": [] so Oxc does not typecheck arbitrary root sources`,
  );
};

const assertProxyTargets = (proxies: readonly OxcProjectProxy[]): void => {
  for (const { config, target } of proxies) {
    const proxyPath = path.join(REPO_ROOT, config);
    assert(existsSync(proxyPath), `Oxc proxy config is missing: ${config}`);

    const extendsPath = readJsonObject(proxyPath)["extends"];
    assert(
      typeof extendsPath === "string",
      `Oxc proxy ${config} must directly extend ${target}`,
    );
    if (typeof extendsPath !== "string") {
      continue;
    }

    const resolvedTarget = normalizeRepoPath(
      path.relative(
        REPO_ROOT,
        path.resolve(path.dirname(proxyPath), extendsPath),
      ),
    );
    assert(
      resolvedTarget === target,
      `Oxc proxy ${config} must extend ${target}, found ${extendsPath}`,
    );
  }
};

const hasDiscoverableAncestorConfig = (
  file: string,
  discoverableConfigFiles: Map<string, Set<string>>,
  configExists: (config: string) => boolean,
): boolean => {
  let directory = path.posix.dirname(file);
  while (directory !== ".") {
    const config = `${directory}/${CONVENTIONAL_TSCONFIG}`;
    if (configExists(config)) {
      return discoverableConfigFiles.get(config)?.has(file) ?? false;
    }
    directory = path.posix.dirname(directory);
  }
  return false;
};

const findSourcesWithoutDiscoverableConfig = (
  repositoryFiles: Set<string>,
  covered: Set<string>,
  discoverableConfigFiles: Map<string, Set<string>>,
  configExists: (config: string) => boolean,
): string[] =>
  [...repositoryFiles]
    .filter((file) =>
      WORKSPACE_PARENTS.some((parent) => file.startsWith(`${parent}/`)),
    )
    .filter((file) => covered.has(file))
    .filter(
      (file) =>
        !hasDiscoverableAncestorConfig(
          file,
          discoverableConfigFiles,
          configExists,
        ),
    )
    .sort();

const assertOxcProjectDiscovery = (projects: string[]): void => {
  const errors = projectAccountingErrors(
    projects,
    OXC_PROJECT_PROXIES,
    OXC_NATIVE_ONLY_PROJECTS,
  );
  assert(
    errors.length === 0,
    `Oxc project-discovery parity failed:\n${errors.join("\n")}`,
  );
  assertRootConfigIsEmpty();
  assertProxyTargets(OXC_PROJECT_PROXIES);
};

const discoverableConfigFiles = (
  projects: string[],
  filesByProject: Map<string, Set<string>>,
): Map<string, Set<string>> => {
  const configFiles = new Map<string, Set<string>>();

  const addConfig = (config: string, project: string): void => {
    const projectFiles = filesByProject.get(project);
    if (!projectFiles) {
      panic(`Missing file list for CI typecheck project ${project}`);
    }
    configFiles.set(config, projectFiles);
  };

  for (const project of projects) {
    if (isConventionalProject(project)) {
      addConfig(project, project);
    }
  }
  for (const { config, target } of OXC_PROJECT_PROXIES) {
    addConfig(config, target);
  }

  return configFiles;
};

const coveredFilesByProject = (
  projects: string[],
): Map<string, Set<string>> => {
  const filesByProject = new Map<string, Set<string>>();

  for (const project of projects) {
    const projectFiles = new Set<string>();
    const output = run([
      process.execPath,
      TSC_NATIVE,
      "-p",
      project,
      "--listFilesOnly",
    ]);
    for (const file of lines(output)) {
      const relative = path.relative(REPO_ROOT, path.resolve(file));
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        continue;
      }
      projectFiles.add(normalizeRepoPath(relative));
    }
    filesByProject.set(project, projectFiles);
  }

  return filesByProject;
};

const coveredFiles = (
  filesByProject: Map<string, Set<string>>,
): Set<string> => {
  const covered = new Set<string>();

  for (const projectFiles of filesByProject.values()) {
    for (const file of projectFiles) {
      covered.add(file);
    }
  }

  return covered;
};

const repositoryTypeScriptFiles = (): Set<string> =>
  new Set(
    lines(
      run([
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.ts",
        "*.tsx",
      ]),
    )
      .filter((file) => existsSync(path.join(REPO_ROOT, file)))
      .filter(isTypeScriptFile),
  );

const repositoryOxcFiles = (): Set<string> =>
  new Set(
    lines(
      run([
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.jsx",
      ]),
    )
      .filter((file) => existsSync(path.join(REPO_ROOT, file)))
      .filter(isOxcSourceFile),
  );

const findUncovered = (
  repositoryFiles: Set<string>,
  covered: Set<string>,
): string[] =>
  [...repositoryFiles]
    .filter((file) => !isExempt(file))
    .filter((file) => !covered.has(file))
    .sort();

const findOxcFilesWithoutProject = (
  repositoryFiles: Set<string>,
  covered: Set<string>,
): string[] =>
  [...repositoryFiles]
    .filter((file) =>
      WORKSPACE_PARENTS.some((parent) => file.startsWith(`${parent}/`)),
    )
    .filter((file) => !isOxcDiscoveryExempt(file))
    .filter((file) => !covered.has(file))
    .sort();

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    panic(message);
  }
};

const selfTest = (): void => {
  assert(isTypeScriptFile("src/new-file.ts"), "must recognize .ts files");
  assert(isTypeScriptFile("src/env.d.ts"), "must recognize declaration files");
  assert(isTypeScriptFile("src/view.tsx"), "must recognize .tsx files");
  assert(!isTypeScriptFile("src/view.js"), "must ignore non-TypeScript files");
  assert(
    isOxcSourceFile("apps/web/file.js"),
    "must recognize .js files for Oxc",
  );
  assert(
    isOxcSourceFile("apps/web/view.jsx"),
    "must recognize .jsx files for Oxc",
  );

  const parsed = supplementalProjects(
    "tsc --noEmit -p tsconfig.test.json && tsc --project=e2e/tsconfig.json",
  );
  assert(
    parsed.join(",") === "tsconfig.test.json,e2e/tsconfig.json",
    "must discover supplemental typecheck projects",
  );

  const duplicateCacheErrors = duplicateBuildInfoErrors([
    {
      buildInfoFile: path.join(
        REPO_ROOT,
        "apps/example/.cache/tsbuildinfo.json",
      ),
      project: "apps/example/tsconfig.json",
    },
    {
      buildInfoFile: path.join(
        REPO_ROOT,
        "apps/example/.cache/tsbuildinfo.json",
      ),
      project: "apps/example/tsconfig.test.json",
    },
  ]);
  assert(
    duplicateCacheErrors.length === 1 &&
      duplicateCacheErrors[0]?.includes("tsconfig.test.json") === true,
    "must reject TypeScript projects that share incremental state",
  );

  const unaccountedProjectErrors = projectAccountingErrors(
    ["apps/example/tsconfig.json", "apps/example/tsconfig.extra.json"],
    [],
    [],
  );
  assert(
    unaccountedProjectErrors.some((error) =>
      error.includes("tsconfig.extra.json"),
    ),
    "must reject a nonstandard CI project without an Oxc proxy or native-only entry",
  );

  const staleProxyErrors = projectAccountingErrors(
    ["apps/example/tsconfig.json"],
    [
      {
        config: "apps/example/scripts/tsconfig.json",
        target: "apps/example/tsconfig.extra.json",
      },
    ],
    [],
  );
  assert(
    staleProxyErrors.some((error) => error.includes("not a nonstandard CI")),
    "must reject an Oxc proxy whose target is no longer a CI project",
  );

  const discoverableConfigs = new Map([
    [
      "apps/example/tsconfig.json",
      new Set([
        "apps/example/src/covered.ts",
        "apps/example/scripts/mismatched.ts",
      ]),
    ],
    [
      "apps/example/scripts/tsconfig.json",
      new Set(["apps/example/scripts/tool.ts"]),
    ],
  ]);
  const sourcesWithoutConfig = findSourcesWithoutDiscoverableConfig(
    new Set([
      "apps/example/src/covered.ts",
      "apps/example/scripts/tool.ts",
      "apps/example/scripts/mismatched.ts",
      "apps/example/excluded.ts",
      "packages/missing/src/uncovered.ts",
    ]),
    new Set([
      "apps/example/src/covered.ts",
      "apps/example/scripts/tool.ts",
      "apps/example/scripts/mismatched.ts",
      "apps/example/excluded.ts",
      "packages/missing/src/uncovered.ts",
    ]),
    discoverableConfigs,
    (config) => discoverableConfigs.has(config),
  );
  assert(
    sourcesWithoutConfig.join(",") ===
      "apps/example/excluded.ts,apps/example/scripts/mismatched.ts,packages/missing/src/uncovered.ts",
    "must use Oxc's nearest config instead of accepting a higher config that covers the source",
  );

  const testProxySources = findSourcesWithoutDiscoverableConfig(
    new Set(["apps/desktop/tests/rpc.golden.test.ts"]),
    new Set(["apps/desktop/tests/rpc.golden.test.ts"]),
    new Map([
      [
        "apps/desktop/tests/tsconfig.json",
        new Set(["apps/desktop/tests/rpc.golden.test.ts"]),
      ],
    ]),
    (config) => config === "apps/desktop/tests/tsconfig.json",
  );
  assert(
    testProxySources.length === 0,
    "must accept a dedicated Oxc proxy for a co-located test project",
  );

  const sourceMaskedByUnregisteredConfig = findSourcesWithoutDiscoverableConfig(
    new Set(["apps/example/scripts/unregistered.ts"]),
    new Set(["apps/example/scripts/unregistered.ts"]),
    new Map([
      [
        "apps/example/tsconfig.json",
        new Set(["apps/example/scripts/unregistered.ts"]),
      ],
    ]),
    (config) =>
      config === "apps/example/scripts/tsconfig.json" ||
      config === "apps/example/tsconfig.json",
  );
  assert(
    sourceMaskedByUnregisteredConfig.join(",") ===
      "apps/example/scripts/unregistered.ts",
    "must reject a nearer physical tsconfig that is absent from CI project discovery",
  );

  const oxcFilesWithoutProject = findOxcFilesWithoutProject(
    new Set([
      "apps/web/covered.js",
      "apps/web/missing.jsx",
      "apps/web/public/prepaint-init.js",
    ]),
    new Set(["apps/web/covered.js"]),
  );
  assert(
    oxcFilesWithoutProject.join(",") === "apps/web/missing.jsx",
    "must reject uncovered JS/JSX while exempting only intentional Oxc exclusions",
  );

  const repository = new Set([
    "src/covered.ts",
    "src/missing.tsx",
    ".oxlint-plugins/__fixtures__/intentionally-invalid.ts",
  ]);
  const covered = new Set(["src/covered.ts"]);
  const uncovered = findUncovered(repository, covered);
  assert(
    uncovered.length === 1 && uncovered[0] === "src/missing.tsx",
    "must reject an uncovered repository source while exempting oxlint fixtures",
  );

  console.log("typecheck-coverage --self-test: PASS");
};

const main = (): void => {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    selfTest();
    return;
  }

  const projects = typecheckProjects();
  assertOxcProjectDiscovery(projects);
  assertIncrementalProjectConfigs(projects);
  const repositoryFiles = repositoryTypeScriptFiles();
  const oxcFiles = repositoryOxcFiles();
  const filesByProject = coveredFilesByProject(projects);
  const covered = coveredFiles(filesByProject);
  const discoverableConfigs = discoverableConfigFiles(projects, filesByProject);
  const sourcesWithoutConfig = findSourcesWithoutDiscoverableConfig(
    oxcFiles,
    covered,
    discoverableConfigs,
    (config) => existsSync(path.join(REPO_ROOT, config)),
  );
  const oxcFilesWithoutProject = findOxcFilesWithoutProject(oxcFiles, covered);
  if (oxcFilesWithoutProject.length > 0) {
    console.error(
      "typecheck-coverage: Oxc workspace JS/JSX/TS/TSX files belong to no CI typecheck project:\n",
    );
    for (const file of oxcFilesWithoutProject) {
      console.error(`  - ${file}`);
    }
    console.error(
      "\nAdd each file to a CI typecheck project, or add a narrowly documented Oxc discovery exception.",
    );
    process.exit(1);
  }
  if (sourcesWithoutConfig.length > 0) {
    console.error(
      "typecheck-coverage: Covered workspace JS/JSX/TS/TSX files have no discoverable Oxc config:\n",
    );
    for (const file of sourcesWithoutConfig) {
      console.error(`  - ${file}`);
    }
    console.error(
      "\nAdd a conventional tsconfig.json ancestor that belongs to CI, or an explicit proxy for its nonstandard CI project.",
    );
    process.exit(1);
  }
  const uncovered = findUncovered(repositoryFiles, covered);

  if (uncovered.length > 0) {
    console.error(
      "typecheck-coverage: TypeScript files belong to no CI typecheck project:\n",
    );
    for (const file of uncovered) {
      console.error(`  - ${file}`);
    }
    console.error(
      "\nAdd each file to the appropriate tsconfig include (and ensure that " +
        "project is run by a CI typecheck script).",
    );
    process.exit(1);
  }

  const candidates = [...repositoryFiles].filter((file) => !isExempt(file));
  console.log(
    `typecheck-coverage: OK. ${candidates.length} TypeScript file(s) covered ` +
      `by ${projects.length} typecheck project(s).`,
  );
};

main();
