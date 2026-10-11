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

const ROOT = path.resolve(import.meta.dir, "../../..");
const EMITTER = "@stll/api#typecheck:declarations";
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
  const consumers = new Set(["@stll/api#typecheck:tests"]);
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
          consumers.add(
            `${packageDir === "." ? "//" : manifest["name"]}#${name}`,
          );
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
      const qualified = dependency.includes("#")
        ? dependency
        : `${id.split("#")[0]}#${dependency}`;
      if (qualified !== EMITTER) {
        fixtureTasks[qualified] ??= {};
      }
    }
  }
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
    apiScripts["typecheck:declarations"] = `${record} ${EMITTER}`;
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
      "apps/api/src/contract.ts",
      "export type Contract = string;\nconst internal = 1;\n",
    );
    write("apps/api/src/contract.test.ts", "// consumer input\n");
    write(
      "record.ts",
      [
        "import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const root = import.meta.dir;",
        "const output = path.join(root, 'apps/api/.cache/typecheck-declarations/apps/api/src/contract.d.ts');",
        "if (process.argv[2] === '@stll/api#typecheck:declarations') {",
        "mkdirSync(path.dirname(output), { recursive: true });",
        "writeFileSync(output, readFileSync(path.join(root, 'apps/api/src/contract.ts'), 'utf8').split('\\n')[0]);",
        "} else if (!existsSync(output)) process.exit(1);",
        "appendFileSync(path.join(root, 'runs.log'), JSON.stringify({ task: process.argv[2], hash: process.env.TURBO_HASH }) + '\\n');",
      ].join("\n"),
    );
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
      (edge) => edge !== "typecheck:declarations" && edge !== EMITTER,
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
    expect(cold).toHaveLength(consumers.size + 1);
    const output = path.join(
      directory,
      "apps/api/.cache/typecheck-declarations/apps/api/src/contract.d.ts",
    );
    rmSync(output);
    run(command);
    expect(executions()).toEqual(cold);
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Contract = string;",
    );
    write(
      "apps/api/src/contract.ts",
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
      "apps/api/src/contract.ts",
      "export type Contract = number;\nconst internal = 2;\n",
    );
    run(command);
    expect(executions()).toHaveLength(3 * (consumers.size + 1));
    expect(readFileSync(output, "utf-8")).toBe(
      "export type Contract = number;",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
