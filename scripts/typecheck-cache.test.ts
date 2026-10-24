import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  apiResolvedTypecheckInputs,
  nativeProgramSpansWorkspaces as spansWorkspaces,
} from "../packages/scripts/src/api-typecheck-inputs";
import {
  explicitTypecheckProjects,
  nativeProjectsForCommand,
  readTypecheckCacheTasks,
  resolvedTypecheckCachePrograms,
  TYPECHECK_CACHE_INPUTS as requiredInputs,
  typecheckCacheContractIssues,
  typecheckCacheProblems as cacheProblems,
  typecheckCacheStructuralProblems,
} from "../packages/scripts/src/typecheck-cache-contract";

const root = path.resolve(import.meta.dirname, "..");
const tasksByName = new Map(readTypecheckCacheTasks(root));

test("every typecheck task declares cacheable program inputs and outputs", () => {
  const tasks = readTypecheckCacheTasks(root);
  const resolved = resolvedTypecheckCachePrograms(root);
  expect(tasks.length).toBeGreaterThan(0);
  // Prepared coverage audits the actual native graphs and their lock policy.
  expect(
    tasks.flatMap(([name, task]) =>
      typecheckCacheStructuralProblems(
        task,
        resolved.has(name) ? "resolved" : "workspace",
      ).map((problem) => `${name}: ${problem}`),
    ),
  ).toEqual([]);
});

test("the cache contract rejects missing inputs, disabled caching and stale lock hashing", () => {
  const valid = { cache: true, inputs: requiredInputs, outputs: [] };
  expect(cacheProblems({ name: "typecheck", task: valid })).toEqual([]);
  expect(cacheProblems({ name: "//#typecheck:repo", task: valid })).toContain(
    "root and cross-workspace programs must hash the full lockfile",
  );
  expect(
    cacheProblems({
      name: "//#typecheck:repo",
      task: {
        ...valid,
        inputs: [...requiredInputs, "$TURBO_ROOT$/bun.lock"],
      },
    }),
  ).toEqual([]);
  expect(
    cacheProblems({ name: "typecheck", task: { ...valid, inputs: [] } }).length,
  ).toBeGreaterThan(0);
  expect(
    cacheProblems({ name: "typecheck", task: { ...valid, cache: false } }),
  ).toContain("must explicitly enable caching");
  expect(
    cacheProblems({
      name: "typecheck",
      task: { ...valid, outputs: undefined },
    }),
  ).toContain("must declare outputs");
  expect(
    cacheProblems({
      name: "typecheck",
      task: {
        ...valid,
        inputs: [...requiredInputs, "$TURBO_ROOT$/bun.lock"],
      },
    }),
  ).toContain("must let Turbo hash relevant lock entries");
});

test("full lock hashing follows resolved workspace boundaries", () => {
  const own = path.join(root, "apps/example/src/entry.ts");
  expect(
    spansWorkspaces([own, path.join(root, "apps/example/src/helper.ts")], root),
  ).toBe(false);
  expect(
    spansWorkspaces(
      [own, path.join(root, "packages/helper/src/value.ts")],
      root,
    ),
  ).toBe(true);
  expect(
    spansWorkspaces(
      [own, path.join(root, "packages/helper/node_modules/lib/index.d.ts")],
      root,
    ),
  ).toBe(false);
  const name = "@stll/example#typecheck";
  const programs = new Set([name]);
  const valid = {
    cache: true,
    inputs: [...requiredInputs, "$TURBO_ROOT$/bun.lock"],
    outputs: [],
  };
  expect(
    cacheProblems({
      name,
      task: valid,
      crossWorkspacePrograms: programs,
    }),
  ).toEqual([]);
  expect(
    cacheProblems({
      name,
      task: { ...valid, inputs: requiredInputs },
      crossWorkspacePrograms: programs,
    }),
  ).toContain("root and cross-workspace programs must hash the full lockfile");
  expect(
    cacheProblems({
      name,
      task: {
        ...valid,
        inputs: valid.inputs.filter(
          (input) => input !== "$TURBO_ROOT$/package.json",
        ),
      },
      crossWorkspacePrograms: programs,
    }),
  ).toContain("missing input $TURBO_ROOT$/package.json");
  expect(cacheProblems({ name, task: valid })).toContain(
    "must let Turbo hash relevant lock entries",
  );
  expect(
    cacheProblems({
      name: "@stll/example#typecheck:aggregate",
      task: valid,
      crossWorkspacePrograms: programs,
    }),
  ).toContain("must let Turbo hash relevant lock entries");
  expect(
    cacheProblems({
      name,
      task: { ...valid, cache: false },
      crossWorkspacePrograms: programs,
    }),
  ).toContain("must explicitly enable caching");
});

test("native discovery binds multi-project commands and single-workspace lock policy", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "typecheck-native-lock-"));
  const app = path.join(directory, "apps/fixture");
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
  };
  try {
    const command =
      'bun check --project=single.json && bun check --project "multi.json"';
    write(
      "apps/fixture/package.json",
      JSON.stringify({
        name: "@stll/fixture",
        scripts: {
          typecheck: command,
          "typecheck:single": "bun check --project single.json",
          "typecheck:aggregate": "bun wrapper.ts --project=single.json",
        },
      }),
    );
    write("apps/fixture/src/single.ts", "export const local = 1;\n");
    write(
      "apps/fixture/src/multi.ts",
      'export { value } from "../../../packages/helper/src/value";\n',
    );
    write("packages/helper/src/value.ts", "export const value = 1;\n");
    for (const name of ["single", "multi"]) {
      write(
        `apps/fixture/${name}.json`,
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            types: [],
          },
          files: [`src/${name}.ts`],
        }),
      );
    }
    const valid = { cache: true, inputs: requiredInputs, outputs: [] };
    const tasks = {
      typecheck: valid,
      "@stll/fixture#typecheck": {
        ...valid,
        inputs: [...requiredInputs, "$TURBO_ROOT$/bun.lock"],
      },
      "@stll/fixture#typecheck:single": valid,
      "@stll/fixture#typecheck:aggregate": valid,
    };
    const writeTasks = () => write("turbo.json", JSON.stringify({ tasks }));
    writeTasks();
    expect(nativeProjectsForCommand(command, app)).toEqual([
      path.join(app, "single.json"),
      path.join(app, "multi.json"),
    ]);
    const projects = explicitTypecheckProjects(directory);
    expect(projects.get("@stll/fixture#typecheck")).toEqual([
      path.join(app, "single.json"),
      path.join(app, "multi.json"),
    ]);
    expect(projects.has("@stll/fixture#typecheck:aggregate")).toBe(false);
    expect(typecheckCacheContractIssues(directory)).toEqual([]);
    expect(
      apiResolvedTypecheckInputs(path.join(app, "single.json")),
    ).not.toContain("$TURBO_ROOT$/bun.lock");
    expect(apiResolvedTypecheckInputs(path.join(app, "multi.json"))).toContain(
      "$TURBO_ROOT$/bun.lock",
    );
    tasks["@stll/fixture#typecheck"].inputs = requiredInputs;
    writeTasks();
    expect(typecheckCacheContractIssues(directory)).toContain(
      "@stll/fixture#typecheck: root and cross-workspace programs must hash the full lockfile",
    );
    tasks["@stll/fixture#typecheck"].inputs = [
      ...requiredInputs,
      "$TURBO_ROOT$/bun.lock",
    ];
    tasks["@stll/fixture#typecheck:single"] = {
      ...valid,
      inputs: [...requiredInputs, "$TURBO_ROOT$/bun.lock"],
    };
    writeTasks();
    expect(typecheckCacheContractIssues(directory)).toContain(
      "@stll/fixture#typecheck:single: must let Turbo hash relevant lock entries",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CI writes task caches only from trusted events", () => {
  const workflow = v.parse(
    v.object({ env: v.object({ TURBO_CACHE: v.string() }) }),
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  expect(workflow.env.TURBO_CACHE).toBe(
    `\${{ ((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'merge_group' || (github.event_name == 'schedule' && github.ref == 'refs/heads/main' && inputs.task_cache_producer == 'validated-main' && inputs.heavy_only == true && inputs.sha == github.sha)) && 'local:rw,remote:rw' || 'local:rw,remote:r' }}`,
  );
});

// The installed Turbo must cache diagnostic-only tasks without a stamp. Keep
// the execution counter outside the package's inputs so it cannot force misses.
for (const taskName of ["typecheck", "//#typecheck:repo"] as const) {
  for (const storage of ["local", "remote"] as const) {
    test(`${taskName} replays from ${storage} cache and invalidates on program inputs`, async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "typecheck-cache-"));
      const artifacts = new Map<string, ArrayBuffer>();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const key = new URL(request.url).pathname;
          if (request.method === "PUT") {
            artifacts.set(key, await request.arrayBuffer());
            return new Response(null, { status: 200 });
          }
          const artifact = artifacts.get(key);
          return artifact === undefined
            ? new Response(null, { status: 404 })
            : new Response(artifact);
        },
      });
      const write = (file: string, content: string) => {
        mkdirSync(path.dirname(path.join(directory, file)), {
          recursive: true,
        });
        writeFileSync(path.join(directory, file), content);
      };
      const run = async () => {
        const command = Bun.spawn(
          [
            path.join(root, "node_modules/.bin/turbo"),
            "run",
            taskName.replace("//#", ""),
            "--cache-dir",
            path.join(directory, "cache"),
            "--cache",
            storage === "local" ? "local:rw" : "remote:rw",
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              TURBO_API: server.url.toString(),
              TURBO_TEAM: "fixture",
              TURBO_TOKEN: "fixture",
              TURBO_TELEMETRY_DISABLED: "1",
              DO_NOT_TRACK: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(command.stdout).text(),
          new Response(command.stderr).text(),
          command.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        return stdout;
      };
      try {
        write(".gitignore", ".turbo/\ncache/\ncalls\n");
        write(
          "package.json",
          JSON.stringify({
            name: "fixture",
            private: true,
            packageManager: "bun@1.4.3",
            workspaces: ["packages/*"],
            scripts: {
              "typecheck:repo": `${process.execPath} packages/example/check.js`,
            },
          }),
        );
        const writeLock = (usedVersion: string, unusedVersion: string) =>
          write(
            "bun.lock",
            JSON.stringify({
              lockfileVersion: 3,
              configVersion: 1,
              workspaces: {
                "": { name: "fixture" },
                "packages/example": {
                  name: "example",
                  dependencies: { "is-number": "7.0.0" },
                },
              },
              packages: {
                "is-number": [
                  `is-number@${usedVersion}`,
                  "",
                  {},
                  "sha512-fixture",
                ],
                unused: [`unused@${unusedVersion}`, "", {}, "sha512-fixture"],
              },
            }),
          );
        writeLock("7.0.0", "1.0.0");
        write(
          "turbo.json",
          JSON.stringify({
            tasks: {
              [taskName]: {
                ...(tasksByName.get(taskName) ??
                  panic(`Missing cache fixture task ${taskName}`)),
                dependsOn: [],
              },
            },
          }),
        );
        write(
          "packages/example/package.json",
          JSON.stringify({
            name: "example",
            dependencies: { "is-number": "7.0.0" },
            scripts: {
              typecheck: `${process.execPath} check.js`,
            },
          }),
        );
        write(
          "packages/example/check.js",
          'require("node:fs").appendFileSync(require("node:path").resolve(__dirname, "../../calls"), "checked\\n"); console.log("checked");',
        );
        write("packages/example/source.ts", "export const value = 1;\n");
        write("packages/example/tsconfig.json", "{}");
        write("packages/typescript-config/base.json", "{}");
        expect(await run()).not.toContain("FULL TURBO");
        expect(await run()).toContain("FULL TURBO");
        expect(readFileSync(path.join(directory, "calls"), "utf-8")).toBe(
          "checked\n",
        );
        writeLock("7.0.0", "2.0.0");
        const unrelated = await run();
        if (taskName === "typecheck") {
          expect(unrelated, "unrelated lock entry").toContain("FULL TURBO");
        } else {
          expect(
            unrelated,
            "root program includes all workspace lock entries",
          ).not.toContain("FULL TURBO");
          expect(await run()).toContain("FULL TURBO");
        }
        writeLock("7.0.1", "2.0.0");
        expect(await run(), "relevant lock entry").not.toContain("FULL TURBO");
        expect(await run()).toContain("FULL TURBO");
        for (const file of [
          "packages/example/source.ts",
          "packages/example/tsconfig.json",
          "packages/typescript-config/base.json",
        ]) {
          write(file, `${readFileSync(path.join(directory, file), "utf-8")}\n`);
          expect(await run(), file).not.toContain("FULL TURBO");
          expect(await run(), file).toContain("FULL TURBO");
        }
        expect(readFileSync(path.join(directory, "calls"), "utf-8")).toBe(
          "checked\n".repeat(taskName === "typecheck" ? 5 : 6),
        );
        if (storage === "remote") {
          expect(artifacts.size).toBeGreaterThan(0);
        }
      } finally {
        await server.stop(true);
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30_000);
  }
}

test("cache input exclusions cannot impersonate dependency inputs", () => {
  const valid = { cache: true, inputs: requiredInputs, outputs: [] };
  const missing = {
    ...valid,
    inputs: [
      ...requiredInputs.filter((input) => input !== "$TURBO_ROOT$/.npmrc"),
      "!src/example.test.ts",
    ],
  };
  expect(cacheProblems({ name: "typecheck", task: missing })).toContain(
    "missing input $TURBO_ROOT$/.npmrc",
  );
  expect(
    cacheProblems({
      name: "typecheck",
      task: { ...valid, inputs: [...requiredInputs, "!$TURBO_ROOT$/.npmrc"] },
    }),
  ).toContain("missing input $TURBO_ROOT$/.npmrc");
  const native = {
    ...valid,
    inputs: requiredInputs.filter((input) => input !== "$TURBO_DEFAULT$"),
  };
  expect(typecheckCacheStructuralProblems(native, "resolved")).toEqual([]);
  expect(typecheckCacheStructuralProblems(native)).toContain(
    "missing input $TURBO_DEFAULT$",
  );
});
