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

import { checkTestInputCoverage } from "./check-test-input-coverage";
import { contextFromNested, evaluate } from "./github-expression";

const root = path.resolve(import.meta.dirname, "..");
const configuration = v.parse(
  v.object({
    globalEnv: v.array(v.string()),
    globalDependencies: v.array(v.string()),
    tasks: v.record(
      v.string(),
      v.looseObject({
        dependsOn: v.optional(v.array(v.string())),
        cache: v.optional(v.boolean()),
      }),
    ),
  }),
  Bun.JSONC.parse(readFileSync(path.join(root, "turbo.json"), "utf-8")),
);
const workflow = v.parse(
  v.object({
    env: v.record(v.string(), v.string()),
    jobs: v.record(
      v.string(),
      v.looseObject({
        steps: v.optional(
          v.array(
            v.looseObject({
              uses: v.optional(v.string()),
              with: v.optional(v.record(v.string(), v.unknown())),
            }),
          ),
          [],
        ),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  ),
);

test("every CI task cache uses stable GitHub storage and trusted writes", () => {
  expect(workflow.env["TURBO_CACHE"]).toBe(
    `\${{ ((github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'merge_group' || (github.event_name == 'schedule' && github.ref == 'refs/heads/main' && inputs.task_cache_producer == 'validated-main' && inputs.heavy_only == true && inputs.sha == github.sha)) && 'local:rw,remote:rw' || 'local:rw,remote:r' }}`,
  );
  const adapters = Object.values(workflow.jobs)
    .flatMap(({ steps }) => steps)
    .filter(({ uses }) => uses?.startsWith("rharkor/caching-for-turbo@"));
  expect(adapters.length).toBeGreaterThan(0);
  for (const adapter of adapters) {
    expect(adapter.with?.["provider"]).toBe("github");
    expect(adapter.with?.["use-relative-cache-path"]).toBe("true");
    expect(adapter.with?.["cache-prefix"]).toBe("task-results-v1_");
  }
});

test("shared writes require a trusted event and a validated scheduled main identity", () => {
  const expression = workflow.env["TURBO_CACHE"];
  expect(expression).toBeDefined();
  const sha = "a".repeat(40);
  for (const event of [
    "push",
    "merge_group",
    "schedule",
    "pull_request",
    "pull_request_target",
    "workflow_dispatch",
    "workflow_run",
  ]) {
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature",
      "refs/pull/1/merge",
    ]) {
      for (const producer of ["read-only", "validated-main"]) {
        for (const heavyOnly of [false, true]) {
          for (const requestedSha of ["", sha, "b".repeat(40)]) {
            const mode = evaluate(
              expression ?? "",
              contextFromNested({
                github: { event_name: event, ref, sha },
                inputs: {
                  task_cache_producer: producer,
                  heavy_only: heavyOnly,
                  sha: requestedSha,
                },
              }),
            );
            const trusted =
              event === "merge_group" ||
              (event === "push" && ref === "refs/heads/main") ||
              (event === "schedule" &&
                ref === "refs/heads/main" &&
                producer === "validated-main" &&
                heavyOnly &&
                requestedSha === sha);
            expect(
              mode,
              JSON.stringify({ event, ref, producer, heavyOnly, requestedSha }),
            ).toBe(trusted ? "local:rw,remote:rw" : "local:rw,remote:r");
          }
        }
      }
    }
  }
});

test("the scheduled caller forwards its ancestry receipt after validation succeeds", () => {
  const caller = v.parse(
    v.object({
      jobs: v.object({
        validate: v.object({ outputs: v.record(v.string(), v.string()) }),
        suites: v.object({
          needs: v.string(),
          if: v.string(),
          with: v.record(v.string(), v.unknown()),
        }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        path.join(root, ".github/workflows/main-heavy.yml"),
        "utf-8",
      ),
    ),
  );
  expect(caller.jobs.suites.needs).toBe("validate");
  expect(caller.jobs.suites.if).toContain("needs.validate.result == 'success'");
  expect(caller.jobs.validate.outputs["task_cache_producer"]).toBe(
    `\${{ steps.ancestor.outputs.task_cache_producer }}`,
  );
  expect(caller.jobs.suites.with["task_cache_producer"]).toBe(
    `\${{ needs.validate.outputs.task_cache_producer }}`,
  );
  expect(caller.jobs.suites.with["sha"]).toBe(
    `\${{ needs.validate.outputs.sha }}`,
  );
});

const missingTestClosure = (tasks: typeof configuration.tasks) =>
  Object.entries(tasks)
    .filter(
      ([name, task]) =>
        /(?:^|#)test$/u.test(name) &&
        task.cache !== false &&
        !(task.dependsOn ?? tasks["test"]?.dependsOn)?.includes("transit"),
    )
    .map(([name]) => name);

test("every cached unit test includes its workspace dependency closure", () => {
  expect(configuration.tasks["transit"]?.dependsOn).toContain("^transit");
  expect(missingTestClosure(configuration.tasks)).toEqual([]);
  for (const [name, task] of Object.entries(configuration.tasks)) {
    if (!/(?:^|#)test$/u.test(name) || task.cache === false) {
      continue;
    }
    expect(
      missingTestClosure({
        ...configuration.tasks,
        [name]: { ...task, dependsOn: [] },
      }),
    ).toContain(name);
  }
});

test("the input census rejects an executed read outside declared inputs", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "task-input-census-"));
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  };
  try {
    write(
      "turbo.json",
      JSON.stringify({ tasks: { test: { inputs: ["$TURBO_DEFAULT$"] } } }),
    );
    write("packages/example/package.json", '{"name":"example"}');
    write("scripts/policy.json", "first");
    write(
      "packages/example/read.test.ts",
      'console.log(require("node:fs").readFileSync(require("node:path").resolve("scripts/policy.json"), "utf8"));',
    );
    const execute = () =>
      Bun.spawnSync([process.execPath, "packages/example/read.test.ts"], {
        cwd: directory,
      });
    expect(execute().stdout.toString().trim()).toBe("first");
    write("scripts/policy.json", "second");
    expect(execute().stdout.toString().trim()).toBe("second");
    expect(checkTestInputCoverage(directory).join("\n")).toContain(
      "does not own",
    );
    write(
      "turbo.json",
      JSON.stringify({
        tasks: {
          "example#test": {
            inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/scripts/policy.json"],
          },
        },
      }),
    );
    expect(checkTestInputCoverage(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const task of ["typecheck", "lint", "test"]) {
  test(`${task} result keys cover every input kind and replay only successful trusted results`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "task-result-cache-"));
    const artifacts = new Map<string, ArrayBuffer>();
    let uploads = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const key = new URL(request.url).pathname;
        if (request.method === "PUT") {
          uploads += 1;
          artifacts.set(key, await request.arrayBuffer());
          return new Response(null);
        }
        const artifact = artifacts.get(key);
        return artifact
          ? new Response(artifact)
          : new Response(null, { status: 404 });
      },
    });
    const write = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), content);
    };
    const fixtureConfig = {
      globalEnv: configuration.globalEnv,
      globalDependencies: configuration.globalDependencies,
      tasks: {
        transit: configuration.tasks["transit"],
        [task]: {
          dependsOn: ["transit"],
          inputs: [
            "$TURBO_DEFAULT$",
            "$TURBO_ROOT$/types/**",
            "$TURBO_ROOT$/scripts/policy.json",
          ],
        },
      },
    };
    const env = {
      ...process.env,
      TURBO_API: server.url.toString(),
      TURBO_TEAM: "fixture",
      TURBO_TOKEN: "fixture",
      TURBO_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      // An inherited cache directory would replay results from earlier runs
      // and leak fixture results into the machine's shared cache.
      TURBO_CACHE_DIR: path.join(directory, ".turbo-cache"),
      TURBO_CACHE: "remote:rw",
      CI: "true",
      PROPERTY_TEST_SEED: "1",
      PROPERTY_TEST_NUM_RUNS_FACTOR: "1",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
    };
    const run = async (args: string[], overrides = {}) => {
      const child = Bun.spawn(
        [
          path.join(root, "node_modules/.bin/turbo"),
          "run",
          task,
          "--filter=example",
          ...args,
        ],
        {
          cwd: directory,
          env: { ...env, ...overrides },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };
    const hash = async (overrides = {}) => {
      const result = await run(["--dry=json"], overrides);
      expect(result.code, result.stderr).toBe(0);
      const summary = v.parse(
        v.object({
          tasks: v.array(
            v.looseObject({ taskId: v.string(), hash: v.string() }),
          ),
        }),
        JSON.parse(result.stdout),
      );
      const selected = summary.tasks.find(
        ({ taskId }) => taskId === `example#${task}`,
      );
      expect(selected).toBeDefined();
      return selected?.hash;
    };
    try {
      write(".gitignore", ".turbo/\n");
      write(
        "package.json",
        JSON.stringify({
          name: "fixture",
          private: true,
          packageManager: "bun@1.4.3",
          workspaces: ["packages/*"],
          devDependencies: { typescript: "6.0.2", oxlint: "1.0.0" },
        }),
      );
      write(
        "bun.lock",
        JSON.stringify({
          lockfileVersion: 3,
          configVersion: 1,
          workspaces: {
            "": {
              name: "fixture",
              devDependencies: { typescript: "6.0.2", oxlint: "1.0.0" },
            },
            "packages/example": {
              name: "example",
              dependencies: { shared: "workspace:*" },
            },
            "packages/shared": { name: "shared" },
          },
          packages: {
            typescript: ["typescript@6.0.2", "", {}, "sha512-fixture"],
            oxlint: ["oxlint@1.0.0", "", {}, "sha512-fixture"],
          },
        }),
      );
      write(
        "packages/example/package.json",
        JSON.stringify({
          name: "example",
          dependencies: { shared: "workspace:*" },
          scripts: { [task]: `${process.execPath} check.js` },
        }),
      );
      write("packages/shared/package.json", JSON.stringify({ name: "shared" }));
      write("packages/shared/value.ts", "export const value = 1;");
      write(
        "packages/shared/value.d.ts",
        "export declare const value: number;",
      );
      write("packages/example/source.ts", "success");
      write("packages/example/tsconfig.json", "{}");
      write("types/global.d.ts", "export {};");
      write("patches/tool.patch", "patch");
      write("scripts/bun-toolchain.gen.json", '{"packageManager":"bun@1.4.3"}');
      write("scripts/policy.json", "{}");
      write("turbo.json", JSON.stringify(fixtureConfig));
      write(
        "packages/example/check.js",
        'console.log("fixture proven result"); process.exit(require("node:fs").readFileSync("source.ts", "utf8") === "failure" ? 9 : 0);',
      );
      const initial = await hash();
      expect(await hash()).toBe(initial);
      for (const file of [
        "packages/example/source.ts",
        "packages/example/tsconfig.json",
        "packages/shared/value.ts",
        "packages/shared/value.d.ts",
        "types/global.d.ts",
        "patches/tool.patch",
        "scripts/bun-toolchain.gen.json",
        "scripts/policy.json",
        "packages/example/package.json",
        "bun.lock",
        "turbo.json",
      ]) {
        const original = readFileSync(path.join(directory, file), "utf-8");
        const mutations: Record<string, string> = {
          "packages/example/tsconfig.json":
            '{"compilerOptions":{"strict":true}}',
          "scripts/bun-toolchain.gen.json": original.replace("1.4.3", "1.4.4"),
          "scripts/policy.json": '{"fixture":true}',
          "bun.lock": original.replaceAll("6.0.2", "6.0.3"),
          "turbo.json": JSON.stringify({
            ...fixtureConfig,
            tasks: {
              ...fixtureConfig.tasks,
              [task]: { ...fixtureConfig.tasks[task], outputs: ["proof/**"] },
            },
          }),
        };
        const changed =
          file === "packages/example/package.json"
            ? original.replace("check.js", "check-changed.js")
            : (mutations[file] ?? `${original}\nchanged`);
        expect(changed, file).not.toBe(original);
        write(file, changed);
        expect(await hash(), file).not.toBe(initial);
        write(file, original);
      }
      const lock = readFileSync(path.join(directory, "bun.lock"), "utf-8");
      write("bun.lock", lock.replaceAll("1.0.0", "1.0.1"));
      expect(await hash(), "Oxlint version").not.toBe(initial);
      write("bun.lock", lock);
      for (const file of [
        "packages/example/added.ts",
        "packages/shared/added.d.ts",
      ]) {
        write(file, "export {};");
        expect(await hash(), `added ${file}`).not.toBe(initial);
        rmSync(path.join(directory, file));
        expect(await hash(), `removed ${file}`).toBe(initial);
      }
      for (const name of configuration.globalEnv) {
        expect(await hash({ [name]: "changed" }), name).not.toBe(initial);
      }
      expect((await run([])).code).toBe(0);
      expect(uploads).toBe(1);
      const replay = await run([], { TURBO_CACHE: "local:rw,remote:r" });
      expect(replay.code).toBe(0);
      expect(replay.stdout).toContain("cache hit");
      expect(replay.stdout).toContain("fixture proven result");
      expect(uploads).toBe(1);
      write("packages/example/source.ts", "changed success");
      // Match the PR workflow policy without a CLI override.
      const readonly = await run([], { TURBO_CACHE: "local:rw,remote:r" });
      expect(readonly.code).toBe(0);
      expect(readonly.stdout).toContain("cache miss");
      expect(uploads).toBe(1);
      // The shared backend contains only the original input hash. This hit
      // must come from the first PR invocation's ephemeral local result.
      const localReplay = await run([], { TURBO_CACHE: "local:rw,remote:r" });
      expect(localReplay.code).toBe(0);
      expect(localReplay.stdout).toContain("cache hit");
      expect(uploads).toBe(1);
      write("packages/example/source.ts", "failure");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = await run([]);
        expect(failed.code).not.toBe(0);
        expect(failed.stdout).toContain("cache miss");
        expect(uploads).toBe(1);
      }
    } finally {
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
