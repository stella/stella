import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { apiResolvedTypecheckInputs } from "./api-typecheck-inputs";

const ROOT = path.resolve(import.meta.dir, "../../..");
const EMITTER = "@stll/api#generate:typecheck-declarations";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const readObject = (filename: string) => {
  const value: unknown = Bun.JSONC.parse(readFileSync(filename, "utf-8"));
  if (!isRecord(value)) {
    panic(`Expected object in ${filename}`);
  }
  return value;
};

test("declaration consumers run after emission and invalidate with API source changes", () => {
  const configuration = readObject(path.join(ROOT, "turbo.json"));
  const tasks = configuration["tasks"];
  if (!isRecord(tasks)) {
    panic("Missing Turbo tasks");
  }
  for (const [id, task] of Object.entries(tasks)) {
    if (!id.startsWith("@stll/api#typecheck:") && id !== EMITTER) {
      continue;
    }
    if (!isRecord(task) || !Array.isArray(task["inputs"])) {
      panic(`Missing task inputs: ${id}`);
    }
    expect(task["inputs"], id).toContain("$TURBO_ROOT$/patches/**");
    expect(task["inputs"], id).toContain(
      "!$TURBO_ROOT$/{apps,packages}/**/.cache/**",
    );
    expect(task["inputs"], id).toContain(
      "!$TURBO_ROOT$/{apps,packages}/**/.turbo/**",
    );
  }
  const consumers = new Set([
    "@stll/api#typecheck:src",
    "@stll/api#typecheck:tests",
  ]);
  for (const [id, task] of Object.entries(tasks)) {
    if (
      isRecord(task) &&
      Array.isArray(task["dependsOn"]) &&
      task["dependsOn"].includes(EMITTER)
    ) {
      consumers.add(id);
    }
  }
  const manifests = [
    "package.json",
    ...new Bun.Glob("{apps,packages}/*/package.json").scanSync(ROOT),
  ];
  const declarations = path.join(ROOT, "apps/api/tsconfig.declarations.json");
  // Discover consumers from compiler references rather than maintaining a
  // second list of the programs that consume the declaration surface.
  for (const filename of manifests) {
    const manifest = readObject(path.join(ROOT, filename));
    const scripts = manifest["scripts"];
    if (!isRecord(scripts)) {
      continue;
    }
    const packageDir = path.dirname(filename);
    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith("typecheck") || typeof command !== "string") {
        continue;
      }
      for (const match of command.matchAll(/--project=([^\s]+)/gu)) {
        const project = match[1];
        if (!project) {
          panic("Missing compiler project");
        }
        const configPath = path.join(ROOT, packageDir, project);
        const references = readObject(configPath)["references"];
        if (!Array.isArray(references)) {
          continue;
        }
        if (
          references.some(
            (reference) =>
              isRecord(reference) &&
              typeof reference["path"] === "string" &&
              path.resolve(path.dirname(configPath), reference["path"]) ===
                declarations,
          )
        ) {
          const owner = packageDir === "." ? "//" : manifest["name"];
          if (typeof owner !== "string") {
            panic(`Missing package name: ${filename}`);
          }
          consumers.add(`${owner}#${name}`);
        }
      }
    }
  }
  const fixtureTasks: Record<string, unknown> = {};
  for (const id of [EMITTER, ...consumers]) {
    const task = tasks[id];
    if (!isRecord(task) || !Array.isArray(task["dependsOn"])) {
      panic(`Missing task dependencies: ${id}`);
    }
    fixtureTasks[id] = task;
    for (const dependency of task["dependsOn"]) {
      if (typeof dependency !== "string") {
        panic(`Invalid dependency: ${id}`);
      }
      const owner = id.split("#")[0];
      if (!owner) {
        panic(`Missing task owner: ${id}`);
      }
      const qualified = dependency.includes("#")
        ? dependency
        : `${owner}#${dependency}`;
      if (qualified !== EMITTER) {
        // Keep prerequisite hashes stable so they cannot mask a missing producer input.
        fixtureTasks[qualified] ??= { inputs: ["package.json"] };
      }
    }
  }
  const producer = fixtureTasks[EMITTER];
  if (!isRecord(producer) || !Array.isArray(producer["inputs"])) {
    panic("Missing producer inputs");
  }
  const inputs = producer["inputs"];
  const sharedSelector = inputs.find(
    (input) =>
      typeof input === "string" &&
      /^\$TURBO_ROOT\$\/packages\/[^/]+\/\*\*$/u.test(input),
  );
  if (typeof sharedSelector !== "string") {
    panic("Missing shared workspace producer input");
  }
  const shared = path.posix.join(
    sharedSelector.replace("$TURBO_ROOT$/", "").slice(0, -3),
    "src/cache-contract-fixture.ts",
  );
  const directory = mkdtempSync(path.join(tmpdir(), "api-typecheck-cache-"));
  const write = (filename: string, content: string) => {
    const target = path.join(directory, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("TURBO_")),
  );
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, {
      cwd: directory,
      env: { ...env, TURBO_TELEMETRY_DISABLED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  const graphIssues = (output: string) => {
    const graph: unknown = JSON.parse(output);
    if (!isRecord(graph) || !Array.isArray(graph["tasks"])) {
      panic("Missing Turbo dry-run graph");
    }
    const graphTasks = graph["tasks"];
    return [...consumers].filter((id) => {
      const task = graphTasks.find(
        (entry: unknown) => isRecord(entry) && entry["taskId"] === id,
      );
      return (
        !isRecord(task) ||
        !Array.isArray(task["dependencies"]) ||
        !task["dependencies"].includes(EMITTER)
      );
    });
  };
  try {
    const rootScripts: Record<string, string> = {};
    const packages = new Map<string, Record<string, string>>();
    for (const id of Object.keys(fixtureTasks)) {
      const owner = id.split("#")[0];
      if (owner && owner !== "//") {
        packages.set(owner, {});
      }
    }
    const record = "bun ../../record.ts";
    for (const id of consumers) {
      const [owner, name] = id.split("#");
      if (!owner || !name) {
        panic(`Invalid task ID: ${id}`);
      }
      if (owner === "//") {
        rootScripts[name] = `bun record.ts ${id}`;
      } else {
        const scripts = packages.get(owner) ?? {};
        scripts[name] = `${record} ${id}`;
        packages.set(owner, scripts);
      }
    }
    const apiScripts = packages.get("@stll/api");
    if (!apiScripts) {
      panic("Missing API consumer");
    }
    apiScripts["generate:typecheck-declarations"] = `${record} ${EMITTER}`;
    write(
      "package.json",
      JSON.stringify({
        name: "cache-fixture",
        private: true,
        packageManager: readObject(path.join(ROOT, "package.json"))[
          "packageManager"
        ],
        workspaces: ["apps/*"],
        scripts: rootScripts,
      }),
    );
    for (const [name, scripts] of packages) {
      write(
        `apps/${name.replace("@stll/", "")}/package.json`,
        JSON.stringify({ name, scripts }),
      );
    }
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    write(
      "bun.lock",
      JSON.stringify({
        lockfileVersion: 3,
        configVersion: 1,
        workspaces: {
          "": { name: "cache-fixture" },
          ...Object.fromEntries(
            [...packages.keys()].map((name) => [
              `apps/${name.replace("@stll/", "")}`,
              { name },
            ]),
          ),
        },
        packages: {},
      }),
    );
    write(".gitignore", "node_modules/\n.turbo/\n**/.cache/\nruns.log\n");
    write(
      "apps/api/src/handlers/visual-sandbox/browser/manifest.ts",
      "export type Contract = string;\nconst internal = 1;\n",
    );
    write("apps/api/src/contract.test.ts", "// consumer input\n");
    write(
      "record.ts",
      [
        "import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const root = import.meta.dir;",
        "const output = path.join(root, 'apps/api/.cache/typecheck-declarations/apps/api/src/handlers/visual-sandbox/browser/manifest.d.ts');",
        "const prepared = path.join(root, 'apps/api/.cache/typecheck-declarations');",
        "const configs = ['roots.json', 'src.json', 'tests.json'];",
        "if (process.argv[2] === '@stll/api#generate:typecheck-declarations') {",
        "mkdirSync(path.dirname(output), { recursive: true });",
        "writeFileSync(output, readFileSync(path.join(root, 'apps/api/src/handlers/visual-sandbox/browser/manifest.ts'), 'utf8').split('\\n')[0]);",
        `const shared = path.join(root, ${JSON.stringify(shared)});`,
        "if (existsSync(shared)) writeFileSync(output, readFileSync(shared, 'utf8'));",
        "for (const name of configs) writeFileSync(path.join(prepared, name), JSON.stringify({ files: [], prepared: true }));",
        "} else if (!existsSync(output) || configs.some(name => !existsSync(path.join(prepared, name)))) process.exit(1);",
        "appendFileSync(path.join(root, 'runs.log'), JSON.stringify({ task: process.argv[2], hash: process.env.TURBO_HASH }) + '\\n');",
      ].join("\n"),
    );
    write("patches/dependency.patch", "dependency types v1\n");
    // Isolate per-task inputs: the repository also hashes patches globally,
    // which would otherwise conceal a missing explicit producer input here.
    const writeTasks = () =>
      write("turbo.json", JSON.stringify({ tasks: fixtureTasks }));
    writeTasks();
    run(["git", "init", "--quiet"]);
    run(["git", "add", "."]);
    const names = [...consumers].map((id) => {
      const name = id.split("#")[1];
      if (!name) {
        panic(`Missing task name: ${id}`);
      }
      return name;
    });
    const command = [
      path.join(ROOT, "node_modules/.bin/turbo"),
      "run",
      ...new Set(names),
      "--cache=local:rw",
      "--cache-dir=.turbo/cache",
    ];
    expect(graphIssues(run([...command, "--dry=json"]))).toEqual([]);
    const testsTask = fixtureTasks["@stll/api#typecheck:tests"];
    if (!isRecord(testsTask) || !Array.isArray(testsTask["dependsOn"])) {
      panic("Missing tests task");
    }
    const dependencies = testsTask["dependsOn"];
    testsTask["dependsOn"] = dependencies.filter(
      (edge) => edge !== "generate:typecheck-declarations" && edge !== EMITTER,
    );
    writeTasks();
    expect(graphIssues(run([...command, "--dry=json"]))).toContain(
      "@stll/api#typecheck:tests",
    );
    testsTask["dependsOn"] = dependencies;
    writeTasks();
    run(command);
    const executions = () =>
      readFileSync(path.join(directory, "runs.log"), "utf-8")
        .trim()
        .split("\n");
    const cold = executions();
    write(
      "packages/dependency/.cache/tsbuildinfo.json",
      "generated compiler state",
    );
    write("packages/dependency/.turbo/task.log", "generated execution log");
    run(command);
    expect(executions()).toEqual(cold);
    expect(cold).toHaveLength(consumers.size + 1);
    const output = path.join(
      directory,
      "apps/api/.cache/typecheck-declarations/apps/api/src/handlers/visual-sandbox/browser/manifest.d.ts",
    );
    rmSync(path.join(directory, "apps/api/.cache/typecheck-declarations"), {
      recursive: true,
    });
    run(command);
    expect(executions()).toEqual(cold);
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Contract = string;",
    );
    for (const name of ["roots", "src", "tests"]) {
      expect(
        readObject(
          path.join(
            directory,
            "apps/api/.cache/typecheck-declarations",
            `${name}.json`,
          ),
        )["prepared"],
      ).toBe(true);
    }
    write(
      "apps/api/src/handlers/visual-sandbox/browser/manifest.ts",
      "export type Contract = number;\nconst internal = 1;\n",
    );
    run(command);
    expect(executions()).toHaveLength(2 * (consumers.size + 1));
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Contract = number;",
    );
    // Turbo keys consumers on the producer's input hash, not declaration bytes:
    // internal changes deliberately invalidate consumers even with identical emit.
    write(
      "apps/api/src/handlers/visual-sandbox/browser/manifest.ts",
      "export type Contract = number;\nconst internal = 2;\n",
    );
    run(command);
    expect(executions()).toHaveLength(3 * (consumers.size + 1));
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Contract = number;",
    );
    const declarationTask = fixtureTasks[EMITTER];
    if (
      !isRecord(declarationTask) ||
      !Array.isArray(declarationTask["inputs"])
    ) {
      panic("Missing declaration cache inputs");
    }
    const originalInputs = declarationTask["inputs"];
    declarationTask["inputs"] = [
      ...originalInputs,
      "!src/handlers/visual-sandbox/browser/manifest.ts",
    ];
    writeTasks();
    run(command);
    const beforeExcludedRoot = executions();
    write(
      "apps/api/src/handlers/visual-sandbox/browser/manifest.ts",
      "export type Contract = boolean;\nconst internal = 2;\n",
    );
    run(command);
    const affectedTasks = (records: string[]) =>
      records.filter((execution) => {
        const entry: unknown = JSON.parse(execution);
        return isRecord(entry) && entry["task"] === EMITTER;
      });
    expect(affectedTasks(executions())).toEqual(
      affectedTasks(beforeExcludedRoot),
    );
    const afterExcludedRoot = executions().length;
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Contract = number;",
    );
    declarationTask["inputs"] = originalInputs;
    writeTasks();
    run(command);
    expect(executions()).toHaveLength(afterExcludedRoot + consumers.size + 1);
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Contract = boolean;",
    );
    const beforePatch = executions().length;
    write("patches/dependency.patch", "dependency types v2\n");
    run(command);
    expect(executions()).toHaveLength(beforePatch + consumers.size + 1);

    producer["inputs"] = inputs.filter(
      (input) => input !== "$TURBO_ROOT$/patches/**",
    );
    writeTasks();
    run(command);
    const beforeMutation = executions().length;
    write("patches/dependency.patch", "dependency types v3\n");
    run(command);
    // Removing the producer input breaks patch invalidation. Only consumers
    // with their own patch inputs rerun; the others replay the stale hash.
    const mutationRuns = executions().slice(beforeMutation);
    expect(mutationRuns.length).toBeLessThan(consumers.size + 1);
    expect(mutationRuns.some((row) => JSON.parse(row).task === EMITTER)).toBe(
      false,
    );
    producer["inputs"] = inputs;
    writeTasks();
    run(command);
    const beforeRestoredPatch = executions().length;
    write("patches/dependency.patch", "dependency types v4\n");
    run(command);
    expect(executions()).toHaveLength(beforeRestoredPatch + consumers.size + 1);
    write(shared, "export type Shared = string;\n");
    run(command);
    const beforeShared = executions().length;
    write(shared, "export type Shared = number;\n");
    run(command);
    expect(executions()).toHaveLength(beforeShared + consumers.size + 1);
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Shared = number;\n",
    );
    producer["inputs"] = inputs.filter((input) => input !== sharedSelector);
    writeTasks();
    run(command);
    const beforeMissingWorkspace = executions().length;
    const cachedWithoutShared = readFileSync(output, "utf-8");
    write(shared, "export type Shared = boolean;\n");
    run(command);
    expect(
      executions()
        .slice(beforeMissingWorkspace)
        .some((row) => JSON.parse(row).task === EMITTER),
    ).toBe(false);
    expect(readFileSync(output, "utf-8")).toBe(cachedWithoutShared);
    producer["inputs"] = inputs;
    writeTasks();
    run(command);
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Shared = boolean;\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("each API test owner invalidates cached checking and rejects a newly introduced type error", async () => {
  // The cache fixture owns both classes itself; it does not require the
  // checkout's prepared compiler projects in an ordinary unit-test job.
  const safe = "src/value.test.ts";
  const coupled = "src/routes.test.ts";
  const tasks = readObject(path.join(ROOT, "turbo.json"))["tasks"];
  if (!isRecord(tasks)) {
    panic("Missing Turbo tasks");
  }
  const sourceTask = tasks["@stll/api#typecheck:src"];
  const testsTask = tasks["@stll/api#typecheck:tests"];
  if (
    !isRecord(sourceTask) ||
    !Array.isArray(sourceTask["inputs"]) ||
    !isRecord(testsTask) ||
    !Array.isArray(testsTask["inputs"])
  ) {
    panic("Missing split checker inputs");
  }
  // Use production inputs; the separate graph fixture covers prerequisite edges.
  const fixtureTasks = {
    "@stll/api#typecheck:src": { inputs: sourceTask["inputs"], outputs: [] },
    "@stll/api#typecheck:tests": { inputs: testsTask["inputs"], outputs: [] },
  };
  const directory = mkdtempSync(path.join(tmpdir(), "api-test-owner-cache-"));
  const write = (filename: string, content: string) => {
    const target = path.join(directory, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("TURBO_")),
  );
  const command = [
    path.join(ROOT, "node_modules/.bin/turbo"),
    "run",
    "typecheck:src",
    "typecheck:tests",
    "--cache=local:rw",
    "--cache-dir=.turbo/cache",
  ];
  const run = () =>
    Bun.spawnSync(command, {
      cwd: directory,
      env: { ...env, TURBO_TELEMETRY_DISABLED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
  const check = (status: number) => {
    const result = run();
    expect(
      result.exitCode,
      result.stdout.toString() + result.stderr.toString(),
    ).toBe(status);
  };
  const executions = () =>
    readFileSync(path.join(directory, "runs.log"), "utf-8").trim().split("\n");
  const writeTasks = () =>
    write("turbo.json", JSON.stringify({ tasks: fixtureTasks }));
  const valid = "export const value: number = 1;\n";
  const invalid = "export const value: number = 'changed';\n";
  try {
    write(
      "package.json",
      JSON.stringify({
        name: "test-owner-cache",
        private: true,
        packageManager: readObject(path.join(ROOT, "package.json"))[
          "packageManager"
        ],
        workspaces: ["apps/*"],
      }),
    );
    write(
      "apps/api/package.json",
      JSON.stringify({
        name: "@stll/api",
        scripts: {
          "typecheck:src": "bun ../../check.ts source tsconfig.src.json",
          "typecheck:tests": "bun ../../check.ts tests tsconfig.tests.json",
        },
      }),
    );
    write(
      "bun.lock",
      JSON.stringify({
        lockfileVersion: 3,
        configVersion: 1,
        workspaces: {
          "": { name: "test-owner-cache" },
          "apps/api": { name: "@stll/api" },
        },
        packages: {},
      }),
    );
    write(".gitignore", "node_modules/\n.turbo/\nruns.log\n");
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    for (const { project, file } of [
      { project: "src", file: coupled },
      { project: "tests", file: safe },
    ]) {
      write(
        `apps/api/tsconfig.${project}.json`,
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [] },
          files: [file],
        }),
      );
      write(`apps/api/${file}`, valid);
    }
    write(
      "check.ts",
      [
        "import { appendFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "appendFileSync(path.join(import.meta.dir, 'runs.log'), process.argv[2] + '\\n');",
        "const child = Bun.spawnSync([process.execPath, 'check', '--no-pretty', '--all', '--project=' + process.argv[3]], { stdout: 'inherit', stderr: 'inherit' });",
        "process.exit(child.exitCode);",
      ].join("\n"),
    );
    writeTasks();
    const init = Bun.spawnSync(["git", "init", "--quiet"], { cwd: directory });
    expect(init.exitCode).toBe(0);
    expect(
      Bun.spawnSync(["git", "add", "."], { cwd: directory }).exitCode,
    ).toBe(0);
    check(0);
    const cold = executions();
    expect(cold.toSorted()).toEqual(["source", "tests"]);
    check(0);
    expect(executions()).toEqual(cold);
    write(`apps/api/${coupled}`, invalid);
    check(1);
    expect(executions().slice(cold.length).toSorted()).toEqual([
      "source",
      "tests",
    ]);
    write(`apps/api/${coupled}`, valid);
    check(0);
    const beforeSafe = executions().length;
    write(`apps/api/${safe}`, invalid);
    check(1);
    expect(executions().slice(beforeSafe).toSorted()).toEqual([
      "source",
      "tests",
    ]);
    write(`apps/api/${safe}`, valid);
    check(0);
    const regenerateInputs = async () => {
      for (const project of ["src", "tests"] as const) {
        fixtureTasks[`@stll/api#typecheck:${project}`].inputs =
          await apiResolvedTypecheckInputs(
            path.join(directory, `apps/api/tsconfig.${project}.json`),
          );
      }
      writeTasks();
    };
    // Both projects can reach API script helpers through relative imports.
    const script = "scripts/test-path-filters.ts";
    write(`apps/api/${script}`, valid);
    for (const file of [safe, coupled]) {
      const relative = repoRelativePath(path.dirname(file), script).replace(
        /\.ts$/u,
        "",
      );
      write(
        `apps/api/${file}`,
        `import { value } from '${relative}';\nexport const checked: number = value;\n`,
      );
    }
    await regenerateInputs();
    check(0);
    const beforeScriptError = executions().length;
    write(`apps/api/${script}`, invalid);
    check(1);
    expect(executions().slice(beforeScriptError).toSorted()).toEqual([
      "source",
      "tests",
    ]);
    write(`apps/api/${script}`, valid);
    check(0);
    for (const file of [safe, coupled]) {
      write(`apps/api/${file}`, valid);
    }
    check(0);
    // A directory excluded from root discovery can still enter via imports.
    const imported = "src/handlers/visual-sandbox/browser/manifest.ts";
    expect(sourceTask["inputs"]).toContain("**");
    write(`apps/api/${imported}`, valid);
    const relative = repoRelativePath(path.dirname(coupled), imported).replace(
      /\.ts$/u,
      "",
    );
    const specifier = relative.startsWith(".") ? relative : `./${relative}`;
    write(
      `apps/api/${coupled}`,
      `import { value } from '${specifier}';\nexport const checked: number = value;\n`,
    );
    write(
      "apps/api/tsconfig.src.json",
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [] },
        files: [coupled],
        exclude: ["src/handlers/visual-sandbox/browser"],
      }),
    );
    await regenerateInputs();
    expect(fixtureTasks["@stll/api#typecheck:src"].inputs).toContain("**");
    check(0);
    const beforeImported = executions().length;
    write(`apps/api/${imported}`, "export const value: string = 'changed';\n");
    check(1);
    expect(executions().slice(beforeImported).toSorted()).toEqual([
      "source",
      "tests",
    ]);
    write(`apps/api/${imported}`, valid);
    check(0);
    write(`apps/api/${coupled}`, valid);
    check(0);
    for (const { project, file, include } of [
      { project: "src", file: coupled, include: "src/new-source/**/*.ts" },
      { project: "tests", file: safe, include: "src/new-tests/**/*.test.ts" },
    ]) {
      write(
        `apps/api/tsconfig.${project}.json`,
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, types: [] },
          files: [file],
          include: [include],
        }),
      );
    }
    await regenerateInputs();
    check(0);
    const beforeNewRoots = executions();
    check(0);
    expect(executions()).toEqual(beforeNewRoots);
    for (const { file, owner } of [
      { file: "src/new-source/standalone.ts", owner: "source" },
      { file: "src/new-tests/standalone.test.ts", owner: "tests" },
    ]) {
      const beforeNewRoot = executions().length;
      write(`apps/api/${file}`, invalid);
      check(1);
      expect(executions().slice(beforeNewRoot)).toContain(owner);
      rmSync(path.join(directory, "apps/api", file));
      check(0);
    }
    const withDiscovery = fixtureTasks["@stll/api#typecheck:src"].inputs;
    fixtureTasks["@stll/api#typecheck:src"].inputs = withDiscovery.filter(
      (input) => input !== "**",
    );
    writeTasks();
    check(0);
    const withoutDiscovery = executions();
    write("apps/api/src/new-source/standalone.ts", invalid);
    check(0);
    expect(executions().filter((owner) => owner === "source")).toEqual(
      withoutDiscovery.filter((owner) => owner === "source"),
    );
    const uncached = Bun.spawnSync(
      [process.execPath, "check", "--all", "--project=tsconfig.src.json"],
      { cwd: path.join(directory, "apps/api"), stdout: "pipe", stderr: "pipe" },
    );
    expect(uncached.exitCode).toBe(1);
    rmSync(path.join(directory, "apps/api/src/new-source/standalone.ts"));
    fixtureTasks["@stll/api#typecheck:src"].inputs = withDiscovery;
    writeTasks();
    check(0);
    // The previous blanket exclusion hides a real coupled-test type error.
    fixtureTasks["@stll/api#typecheck:src"].inputs = [
      ...sourceTask["inputs"].filter(
        (input) => typeof input !== "string" || !/\.test\.tsx?$/u.test(input),
      ),
      "!src/**/*.test.ts",
      "!src/**/*.test.tsx",
    ];
    writeTasks();
    check(0);
    const beforeMutation = executions();
    write(`apps/api/${coupled}`, invalid);
    check(0);
    expect(executions().filter((owner) => owner === "source")).toEqual(
      beforeMutation.filter((owner) => owner === "source"),
    );
    const direct = Bun.spawnSync(
      [
        process.execPath,
        "check",
        "--no-pretty",
        "--all",
        "--project=tsconfig.src.json",
      ],
      { cwd: path.join(directory, "apps/api"), stdout: "pipe", stderr: "pipe" },
    );
    expect(direct.exitCode).toBe(1);
    expect(direct.stdout.toString() + direct.stderr.toString()).toContain(
      coupled,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
