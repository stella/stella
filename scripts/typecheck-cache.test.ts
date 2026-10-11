import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

const taskSchema = v.looseObject({
  cache: v.optional(v.boolean()),
  inputs: v.optional(v.array(v.string())),
  outputs: v.optional(v.array(v.string())),
  dependsOn: v.optional(v.array(v.string())),
});
const root = path.resolve(import.meta.dirname, "..");
const { tasks } = v.parse(
  v.object({ tasks: v.record(v.string(), taskSchema) }),
  ts.parseConfigFileTextToJson(
    "turbo.json",
    readFileSync(path.join(root, "turbo.json"), "utf-8"),
  ).config,
);
const requiredInputs = [
  "$TURBO_DEFAULT$",
  "$TURBO_ROOT$/.npmrc",
  "$TURBO_ROOT$/bunfig.toml",
  "$TURBO_ROOT$/package.json",
  "$TURBO_ROOT$/packages/typescript-config/**",
  "$TURBO_ROOT$/patches/**",
  "$TURBO_ROOT$/types/**",
];
const typecheckTasks = Object.entries(tasks).filter(([name]) =>
  /(?:^|#)typecheck(?::|$)/u.test(name),
);
const cacheProblems = (task: v.InferOutput<typeof taskSchema>) => [
  ...(task.cache === true ? [] : ["must explicitly enable caching"]),
  ...requiredInputs
    .filter(
      (input) =>
        !task.inputs?.some((pattern) => new Bun.Glob(pattern).match(input)),
    )
    .map((input) => `missing input ${input}`),
  ...(task.inputs?.includes("$TURBO_ROOT$/bun.lock")
    ? ["must let Turbo hash relevant lock entries"]
    : []),
  ...(task.outputs === undefined ? ["must declare outputs"] : []),
];

test("every typecheck task declares cacheable program inputs and outputs", () => {
  expect(typecheckTasks.length).toBeGreaterThan(0);
  expect(
    typecheckTasks.flatMap(([name, task]) =>
      cacheProblems(task).map((problem) => `${name}: ${problem}`),
    ),
  ).toEqual([]);
});

test("the cache contract rejects missing inputs, disabled caching and stale lock hashing", () => {
  const valid = { cache: true, inputs: requiredInputs, outputs: [] };
  expect(cacheProblems(valid)).toEqual([]);
  expect(cacheProblems({ ...valid, inputs: [] }).length).toBeGreaterThan(0);
  expect(cacheProblems({ ...valid, cache: false })).toContain(
    "must explicitly enable caching",
  );
  expect(cacheProblems({ ...valid, outputs: undefined })).toContain(
    "must declare outputs",
  );
  expect(
    cacheProblems({
      ...valid,
      inputs: [...requiredInputs, "$TURBO_ROOT$/bun.lock"],
    }),
  ).toContain("must let Turbo hash relevant lock entries");
});

test("CI writes remote task caches only from main", () => {
  const workflow = v.parse(
    v.object({ env: v.object({ TURBO_CACHE: v.string() }) }),
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  expect(workflow.env.TURBO_CACHE).toBe(
    `\${{ github.ref == 'refs/heads/main' && 'local:rw,remote:rw' || 'local:rw,remote:r' }}`,
  );
});

// The installed Turbo must cache diagnostic-only tasks without a stamp. Keep
// the execution counter outside the package's inputs so it cannot force misses.
for (const storage of ["local", "remote"] as const) {
  test(`diagnostic-only typechecks replay from ${storage} cache and invalidate on program inputs`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "typecheck-cache-"));
    const artifacts = new Map<string, Uint8Array>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const key = new URL(request.url).pathname;
        if (request.method === "PUT") {
          artifacts.set(key, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        const artifact = artifacts.get(key);
        return artifact === undefined
          ? new Response(null, { status: 404 })
          : new Response(artifact);
      },
    });
    const write = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), content);
    };
    const run = async () => {
      const command = Bun.spawn(
        [
          path.join(root, "node_modules/.bin/turbo"),
          "run",
          "typecheck",
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
      write(
        "package.json",
        JSON.stringify({
          name: "fixture",
          private: true,
          packageManager: "bun@1.4.3",
          workspaces: ["packages/*"],
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
            typecheck: { ...tasks["typecheck"], dependsOn: [] },
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
        'require("node:fs").appendFileSync("../../calls", "checked\\n"); console.log("checked");',
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
      expect(await run(), "unrelated lock entry").toContain("FULL TURBO");
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
        "checked\n".repeat(5),
      );
      if (storage === "remote") {
        expect(artifacts.size).toBeGreaterThan(0);
      }
    } finally {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
