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

const root = path.resolve(import.meta.dir, "../../..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

test("one package script and Turbo task own API type generation", () => {
  const manifests = ["package.json"];
  for (const scope of ["apps", "packages"]) {
    manifests.push(
      ...new Bun.Glob(`${scope}/*/package.json`).scanSync({ cwd: root }),
    );
  }
  const owners: string[] = [];
  for (const filename of manifests) {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, filename), "utf-8"),
    );
    if (
      !isRecord(manifest) ||
      typeof manifest["name"] !== "string" ||
      !isRecord(manifest["scripts"])
    ) {
      continue;
    }
    for (const [name, command] of Object.entries(manifest["scripts"])) {
      if (
        typeof command === "string" &&
        command.includes("generate-web-api-types.ts")
      ) {
        owners.push(`${manifest["name"]}#${name}`);
      }
    }
  }
  expect(owners).toEqual(["@stll/web#generate:api-types"]);
  const entrypoint = readFileSync(
    path.join(root, "apps/api/scripts/generate-web-api-types.ts"),
    "utf-8",
  );
  expect(entrypoint).toMatch(
    /if \(import\.meta\.main\)\s*\{\s*const generated = await withGenerationLock\(\{[^}]*run: main,/u,
  );
  expect(entrypoint).toContain(
    'generated.unwrap("API type generation failed");',
  );
  expect(entrypoint).not.toMatch(/\bmain\(\)/u);
  const config: unknown = Bun.JSONC.parse(
    readFileSync(path.join(root, "turbo.json"), "utf-8"),
  );
  if (!isRecord(config) || !isRecord(config["tasks"])) {
    panic("Turbo configuration has no tasks");
  }
  expect(
    Object.keys(config["tasks"]).filter((name) =>
      name.endsWith("#generate:api-types"),
    ),
  ).toEqual(owners);
});

test("web sources generate once across compiler tasks and restore until source inputs change", () => {
  const parsed: unknown = Bun.JSONC.parse(
    readFileSync(path.join(root, "turbo.json"), "utf-8"),
  );
  if (!isRecord(parsed) || !isRecord(parsed["tasks"])) {
    panic("Turbo configuration has no tasks");
  }
  const tasks = parsed["tasks"];
  const apiManifest: unknown = JSON.parse(
    readFileSync(path.join(root, "apps/api/package.json"), "utf-8"),
  );
  if (
    !isRecord(apiManifest) ||
    !isRecord(apiManifest["scripts"]) ||
    typeof apiManifest["scripts"]["gen:web-api-types"] !== "string"
  ) {
    panic("API generation command is missing");
  }
  const apiGenerationCommand = apiManifest["scripts"]["gen:web-api-types"];
  const consumers = ["lint", "typecheck", "test"];
  const consumerTasks: Record<string, unknown> = {};
  for (const consumer of consumers) {
    const task = tasks[`@stll/web#${consumer}`];
    if (!isRecord(task) || !Array.isArray(task["dependsOn"])) {
      panic(`Missing web compiler task: ${consumer}`);
    }
    expect(task["dependsOn"]).toContain("generate:api-types");
    expect(task["dependsOn"]).toContain("generate:route-tree");
    consumerTasks[`@stll/web#${consumer}`] = {
      dependsOn: task["dependsOn"].filter(
        (dependency) => dependency !== "generate:messages",
      ),
    };
  }
  const directory = mkdtempSync(
    path.join(tmpdir(), "stella-web-generation-cache-"),
  );
  const write = (filename: string, content: string) => {
    const filenamePath = path.join(directory, filename);
    mkdirSync(path.dirname(filenamePath), { recursive: true });
    writeFileSync(filenamePath, content);
  };
  // The fixture owns its cache behaviour, so settings from an enclosing Turbo
  // run (such as TURBO_FORCE) must not reach the nested invocations.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("TURBO_") && key !== "CI_GENERATED_SOURCES_MANIFEST",
    ),
  );
  const run = (command: string[]) => {
    const child = Bun.spawnSync(command, {
      cwd: directory,
      env: { ...env, TURBO_TELEMETRY_DISABLED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
  };
  try {
    write(
      "package.json",
      JSON.stringify({
        name: "cache-fixture",
        private: true,
        packageManager: "bun@1.4.2",
        workspaces: ["apps/*", "packages/*"],
      }),
    );
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    write(
      "apps/web/package.json",
      JSON.stringify({
        name: "@stll/web",
        scripts: {
          "generate:api-types": "bun ../api/scripts/generate-web-api-types.ts",
          "generate:route-tree": "bun scripts/generate-route-tree.ts",
          typegen: "bun scripts/typegen.ts",
          ...Object.fromEntries(
            consumers.map((consumer) => [
              consumer,
              `bun -e 'if (!["src/generated/api-routes.gen.ts", "src/routeTree.gen.ts", "src/route-templates.gen.ts"].every((file) => require("node:fs").existsSync(file))) process.exit(1)'`,
            ]),
          ),
        },
      }),
    );
    write(
      "apps/api/package.json",
      JSON.stringify({
        name: "@stll/api",
        scripts: {
          "generate:capability-runtime":
            "bun scripts/generate-capability-runtime.ts",
          "gen:web-api-types": apiGenerationCommand,
          "generate:typecheck-declarations": "bun -e ''",
        },
      }),
    );
    const apiTask = tasks["@stll/api#generate:capability-runtime"];
    if (
      !isRecord(apiTask) ||
      !Array.isArray(apiTask["outputs"]) ||
      !apiTask["outputs"].every((output) => typeof output === "string")
    ) {
      panic("Missing API runtime producer outputs");
    }
    const mcpTask = tasks["@stll/mcp-apps#build"];
    if (
      !isRecord(mcpTask) ||
      !Array.isArray(mcpTask["outputs"]) ||
      !mcpTask["outputs"].every((output) => typeof output === "string")
    ) {
      panic("Missing MCP app producer outputs");
    }
    const mcpOutputs = mcpTask["outputs"].map((output) =>
      output.replaceAll("**", "fixture.ts").replaceAll("*", "fixture"),
    );
    write(
      "packages/mcp-apps/package.json",
      JSON.stringify({
        name: "@stll/mcp-apps",
        scripts: { build: "bun scripts/build-mcp-apps.ts" },
      }),
    );
    write("packages/mcp-apps/src/fixture/app.html", "<!doctype html>");
    write(
      "packages/mcp-apps/scripts/build-mcp-apps.ts",
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        `for (const output of ${JSON.stringify(mcpOutputs)}) { mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, 'generated MCP bytes'); }`,
      ].join("\n"),
    );
    const apiOutputs = apiTask["outputs"].map((output) =>
      output.replaceAll("**", "fixture.ts").replaceAll("*", "fixture"),
    );
    write(
      "apps/api/scripts/generate-capability-runtime.ts",
      [
        "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "process.chdir(path.resolve(import.meta.dir, '..'));",
        `for (const output of ${JSON.stringify(apiOutputs)}) { mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, 'generated API bytes'); }`,
        "appendFileSync('../../runs.log', 'api-runtime\\n');",
      ].join("\n"),
    );
    write(
      ".gitignore",
      `node_modules/\n.turbo/\napps/web/src/generated/api-routes.gen.ts\napps/web/src/routeTree.gen.ts\napps/web/src/route-templates.gen.ts\nruns.log\ntask-hash\n${apiTask[
        "outputs"
      ]
        .map((output) => `apps/api/${output}\n`)
        .join(
          "",
        )}${mcpTask["outputs"].map((output) => `packages/mcp-apps/${output}\n`).join("")}`,
    );
    write("apps/api/src/contract.ts", "export type Contract = string;\n");
    write("apps/web/src/routes/index.tsx", "export const route = '/';\n");
    write("apps/web/route-tree.config.ts", "export const options = {};\n");
    write(
      "apps/web/scripts/route-template-manifest.ts",
      "export const version = 1;\n",
    );
    write("apps/web/vite.config.ts", "export default {};\n");
    const generator = (output: string) =>
      [
        "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('src/generated', { recursive: true });",
        "writeFileSync('../../task-hash', process.env.TURBO_HASH ?? '');",
        `writeFileSync(${JSON.stringify(output)}, ${JSON.stringify("generated bytes\n")});`,
        `appendFileSync('../../runs.log', ${JSON.stringify(`${output}\n`)});`,
        "if (process.argv.includes('--check')) appendFileSync('../../checks.log', 'checked\\n');",
      ].join("\n");
    write(
      "apps/api/scripts/generate-web-api-types.ts",
      generator("src/generated/api-routes.gen.ts"),
    );
    write(
      "apps/web/scripts/generate-route-tree.ts",
      `${generator("src/routeTree.gen.ts")}\nwriteFileSync("src/route-templates.gen.ts", "generated templates\\n");`,
    );
    write(
      "turbo.json",
      JSON.stringify({
        tasks: {
          "@stll/api#generate:capability-runtime": apiTask,
          "@stll/mcp-apps#build": mcpTask,
          "@stll/api#generate:typecheck-declarations": {
            inputs: ["src/**"],
            outputs: [],
          },
          "@stll/web#generate:api-types": tasks["@stll/web#generate:api-types"],
          "@stll/web#generate:route-tree":
            tasks["@stll/web#generate:route-tree"],
          transit: {},
          ...consumerTasks,
        },
      }),
    );
    run(["git", "init", "--quiet"]);
    write(
      "bun.lock",
      JSON.stringify({
        lockfileVersion: 3,
        configVersion: 1,
        workspaces: {
          "": { name: "cache-fixture" },
          "apps/api": { name: "@stll/api" },
          "apps/web": { name: "@stll/web" },
          "packages/mcp-apps": { name: "@stll/mcp-apps" },
        },
        packages: {},
      }),
    );
    run(["git", "add", "."]);
    const command = [
      path.join(root, "node_modules/.bin/turbo"),
      "run",
      "generate:api-types",
      "--filter=@stll/web",
      "--cache=local:rw",
      "--cache-dir",
      path.join(directory, ".turbo/cache"),
    ];
    run([...command.slice(0, 2), ...consumers, ...command.slice(3)]);
    const executions = readFileSync(path.join(directory, "runs.log"), "utf-8");
    expect(executions.trim().split("\n")).toHaveLength(3);
    run([process.execPath, "--cwd=apps/api", "run", "gen:web-api-types"]);
    expect(readFileSync(path.join(directory, "runs.log"), "utf-8")).toBe(
      executions,
    );
    expect(readFileSync(path.join(directory, "task-hash"), "utf-8")).toMatch(
      /^[a-f0-9]+$/u,
    );
    const output = path.join(
      directory,
      "apps/web/src/generated/api-routes.gen.ts",
    );
    run(["git", "check-ignore", "apps/web/src/generated/api-routes.gen.ts"]);
    rmSync(output);
    const routeOutput = path.join(directory, "apps/web/src/routeTree.gen.ts");
    rmSync(routeOutput);
    const routeTemplates = path.join(
      directory,
      "apps/web/src/route-templates.gen.ts",
    );
    rmSync(routeTemplates);
    // Environment setup and compiler outputs must not change producer inputs.
    for (const file of [
      "apps/api/.env",
      "apps/api/.env.local",
      "apps/api/.turbo/turbo-typecheck.log",
      "apps/api/tsconfig.tsbuildinfo",
      "packages/scripts/.turbo/turbo-lint.log",
      "packages/scripts/.cache/tsbuildinfo.json",
      "packages/scripts/tsconfig.tsbuildinfo",
    ]) {
      write(file, "transient output\n");
    }
    run(command);
    expect(readFileSync(path.join(directory, "runs.log"), "utf-8")).toBe(
      executions,
    );
    expect(readFileSync(output, "utf-8")).toBe("generated bytes\n");
    expect(readFileSync(routeOutput, "utf-8")).toBe("generated bytes\n");
    expect(readFileSync(routeTemplates, "utf-8")).toBe("generated templates\n");
    write("apps/api/src/contract.ts", "export type Contract = number;\n");
    run(command);
    expect(
      readFileSync(path.join(directory, "runs.log"), "utf-8")
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(5);
    write(
      "apps/web/src/routes/index.tsx",
      "export const route = '/changed';\n",
    );
    run(command);
    expect(
      readFileSync(path.join(directory, "runs.log"), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(7);
    write(
      "apps/web/scripts/route-template-manifest.ts",
      "export const version = 2;\n",
    );
    run(command);
    expect(
      readFileSync(path.join(directory, "runs.log"), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(9);
    run([
      process.execPath,
      "--cwd=apps/api",
      "run",
      "gen:web-api-types",
      "--check",
    ]);
    expect(readFileSync(path.join(directory, "checks.log"), "utf-8")).toBe(
      "checked\n",
    );
    // Exercise the real prepare entrypoint with only Bun and system tools on
    // PATH, as in direct CI and image-build invocations.
    write(
      "scripts/ci-generated-sources.ts",
      readFileSync(path.join(root, "scripts/ci-generated-sources.ts"), "utf-8"),
    );
    const generatedModule = path.join(
      root,
      "packages/scripts/src/generated-files.ts",
    );
    write(
      "scripts/generated-files.ts",
      `export { CI_GENERATED_FILES, CI_GENERATION_COMMANDS } from ${JSON.stringify(generatedModule)};`,
    );
    mkdirSync(path.join(directory, "packages/scripts"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/scripts/src"),
      path.join(directory, "packages/scripts/src"),
      "dir",
    );
    write(
      "packages/cli/package.json",
      JSON.stringify({
        name: "@stll/cli",
        scripts: { "codegen:runtime": "bun scripts/codegen.ts" },
      }),
    );
    write(
      "packages/cli/scripts/codegen.ts",
      "console.log('CLI runtime generated');",
    );
    write("apps/web/scripts/typegen.ts", "console.log('messages generated');");
    write(
      "scripts/prepare-mcp-apps.ts",
      [
        "import path from 'node:path';",
        "const build = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd: path.resolve(import.meta.dir, '../packages/mcp-apps'), stdout: 'inherit', stderr: 'inherit' });",
        "process.exit(build.exitCode);",
      ].join("\n"),
    );
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, path.join(bin, "bun"));
    const prepareEnv = {
      ...env,
      PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    };
    const missingTurbo = Bun.spawnSync(["/bin/sh", "-c", "command -v turbo"], {
      env: prepareEnv,
    });
    expect(missingTurbo.exitCode).not.toBe(0);
    expect(missingTurbo.stdout.toString()).toBe("");
    expect(
      Bun.spawnSync(["/bin/sh", "-c", "command -v bun"], { env: prepareEnv })
        .stdout.toString()
        .trim(),
    ).toBe(path.join(bin, "bun"));
    const prepare = () =>
      Bun.spawnSync(
        [process.execPath, "scripts/ci-generated-sources.ts", "prepare"],
        { cwd: directory, env: prepareEnv, stdout: "pipe", stderr: "pipe" },
      );
    write(
      "scripts/check-mcp-generated-tracking.ts",
      readFileSync(
        path.join(root, "scripts/check-mcp-generated-tracking.ts"),
        "utf-8",
      ),
    );
    const prepared = prepare();
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
    expect(readFileSync(output, "utf-8")).toBe("generated bytes\n");
    // The old PATH lookup must fail in this same fixture.
    write(
      "scripts/generated-files.ts",
      `
      import { CI_GENERATED_FILES, CI_GENERATION_COMMANDS as commands } from ${JSON.stringify(generatedModule)};
      export { CI_GENERATED_FILES };
      export const CI_GENERATION_COMMANDS = commands.map(command => command.includes('generate:api-types') ? ['bun', 'exec', 'turbo', 'run', 'generate:api-types', '--filter=@stll/web'] : command);
    `,
    );
    const unrooted = prepare();
    expect(unrooted.exitCode).not.toBe(0);
    expect(unrooted.stderr.toString()).toContain("command not found: turbo");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
