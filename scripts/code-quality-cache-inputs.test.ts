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

import { generateBunToolchain } from "./generate-bun-toolchain";

const root = path.resolve(import.meta.dir, "..");
const taskSchema = v.looseObject({ inputs: v.optional(v.array(v.string())) });
const configSchema = v.looseObject({
  tasks: v.record(v.string(), taskSchema),
  globalDependencies: v.optional(v.array(v.string())),
  remoteCache: v.optional(
    v.looseObject({
      timeout: v.optional(v.number()),
      uploadTimeout: v.optional(v.number()),
    }),
  ),
});
const configuration = v.parse(
  configSchema,
  Bun.JSONC.parse(readFileSync(path.join(root, "turbo.json"), "utf-8")),
);
const qualityInputProblems = ({
  tasks,
}: v.InferOutput<typeof configSchema>) => {
  const problems: string[] = [];
  for (const [name, task] of Object.entries(tasks)) {
    const baseName = name.split("#").at(-1) ?? "";
    if (name.startsWith("//#") || baseName !== "lint") {
      continue;
    }
    const inputs = task.inputs ??
      tasks[baseName]?.inputs ?? ["$TURBO_DEFAULT$"];
    const forbiddenInputs = [
      "$TURBO_ROOT$/bun.lock",
      "$TURBO_ROOT$/package.json",
    ];
    for (const forbidden of forbiddenInputs) {
      if (inputs.includes(forbidden)) {
        problems.push(`${name}: ${forbidden}`);
      }
    }
    if (!inputs.includes("$TURBO_DEFAULT$")) {
      problems.push(`${name}: missing default inputs`);
    }
  }
  return problems;
};

test("lint tasks avoid redundant dependency inputs; native typecheck keeps its separate contract", () => {
  expect(Object.keys(configuration.tasks)).toContain("lint");
  expect(Object.keys(configuration.tasks)).toContain("typecheck");
  expect(qualityInputProblems(configuration)).toEqual([]);
});

test("lint input guard accepts inheritance and rejects restored whole-file inputs in every lint task", () => {
  expect(
    qualityInputProblems({
      tasks: {
        lint: { inputs: ["$TURBO_DEFAULT$"] },
        "@stll/example#lint": {},
        typecheck: { inputs: ["$TURBO_DEFAULT$"] },
        "@stll/example#typecheck": {},
      },
    }),
  ).toEqual([]);
  for (const [name, task] of Object.entries(configuration.tasks)) {
    const baseName = name.split("#").at(-1) ?? "";
    if (name.startsWith("//#") || baseName !== "lint") {
      continue;
    }
    const inputs = task.inputs ??
      configuration.tasks[baseName]?.inputs ?? ["$TURBO_DEFAULT$"];
    const forbiddenInputs = [
      "$TURBO_ROOT$/bun.lock",
      "$TURBO_ROOT$/package.json",
    ];
    for (const forbidden of forbiddenInputs) {
      const mutated = {
        tasks: {
          ...configuration.tasks,
          [name]: { ...task, inputs: [...inputs, forbidden] },
        },
      };
      expect(qualityInputProblems(mutated)).toContain(`${name}: ${forbidden}`);
    }
  }
});

// A root task hashes only root dependencies in Turbo, while these projects
// import workspace source. Its full dependency inputs preserve that boundary.
const rootDependencyProblems = (inputs: readonly string[]) =>
  ["$TURBO_ROOT$/bun.lock", "$TURBO_ROOT$/package.json"].filter(
    (required) => !inputs.includes(required),
  );

test("root typecheck retains complete dependency inputs for cross-workspace imports", () => {
  const inputs = configuration.tasks["//#typecheck:repo"]?.inputs ?? [];
  expect(rootDependencyProblems(inputs)).toEqual([]);
  for (const required of [
    "$TURBO_ROOT$/bun.lock",
    "$TURBO_ROOT$/package.json",
  ]) {
    expect(
      rootDependencyProblems(inputs.filter((input) => input !== required)),
    ).toEqual([required]);
  }
});

test("the narrow Bun pin is a global cache input without the whole manifest", () => {
  expect(configuration.globalDependencies).toContain(
    "scripts/bun-toolchain.gen.json",
  );
  expect(configuration.globalDependencies).not.toContain("package.json");
  const mutation = configuration.globalDependencies?.filter(
    (input) => input !== "scripts/bun-toolchain.gen.json",
  );
  expect(mutation).not.toContain("scripts/bun-toolchain.gen.json");
});

const remoteCacheProblems = ({
  remoteCache,
}: v.InferOutput<typeof configSchema>) => {
  const problems: string[] = [];
  for (const field of ["timeout", "uploadTimeout"] as const) {
    if (remoteCache?.[field] !== 20) {
      problems.push(`remoteCache.${field}: expected 20 seconds`);
    }
  }
  return problems;
};

test("remote cache reads and uploads have bounded twenty-second waits", () => {
  expect(remoteCacheProblems(configuration)).toEqual([]);
  expect(
    remoteCacheProblems({ ...configuration, remoteCache: undefined }),
  ).toEqual([
    "remoteCache.timeout: expected 20 seconds",
    "remoteCache.uploadTimeout: expected 20 seconds",
  ]);
  for (const field of ["timeout", "uploadTimeout"] as const) {
    for (const changed of [undefined, 0, 21]) {
      const mutated = {
        ...configuration,
        remoteCache: { ...configuration.remoteCache, [field]: changed },
      };
      expect(remoteCacheProblems(mutated)).toContain(
        `remoteCache.${field}: expected 20 seconds`,
      );
    }
  }
});

const summarySchema = v.object({
  tasks: v.array(v.looseObject({ taskId: v.string(), hash: v.string() })),
});

// Exercise the pinned Turbo binary and its Bun parser, not a model of their hashing.
// https://github.com/vercel/turborepo/tree/v2.11.6/crates/turborepo-lockfiles/src/bun
// Root external dependencies intentionally remain global in Turbo 2.11.6.
test("Bun pins invalidate every quality task without hashing unrelated root manifest edits", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "quality-cache-inputs-"));
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(fixture, name), JSON.stringify(value));
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, {
      cwd: fixture,
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  try {
    const manifest = {
      name: "fixture",
      private: true,
      packageManager: "bun@1.4.3",
      workspaces: ["packages/*"],
      devDependencies: { tool: "*" },
    };
    write("package.json", manifest);
    expect(await generateBunToolchain(fixture, false)).toBe(1);
    expect(await generateBunToolchain(fixture, true)).toBe(0);
    expect(await generateBunToolchain(fixture, false)).toBe(0);
    const turbo = {
      globalDependencies: configuration.globalDependencies,
      tasks: {
        lint: { inputs: ["$TURBO_DEFAULT$"] },
        typecheck: { inputs: ["$TURBO_DEFAULT$"] },
      },
    };
    write("turbo.json", turbo);
    for (const name of ["a", "b"]) {
      mkdirSync(path.join(fixture, "packages", name), { recursive: true });
      write(`packages/${name}/package.json`, {
        name,
        version: "1.0.0",
        scripts: { lint: "echo lint", typecheck: "echo typecheck" },
        dependencies: { [name === "a" ? "dep-a" : "dep-b"]: "*" },
      });
    }
    const lock = (dependencyVersion: string, toolVersion: string) =>
      write("bun.lock", {
        lockfileVersion: 3,
        configVersion: 1,
        workspaces: {
          "": { name: "fixture", devDependencies: { tool: "*" } },
          "packages/a": {
            name: "a",
            version: "1.0.0",
            dependencies: { "dep-a": "*" },
          },
          "packages/b": {
            name: "b",
            version: "1.0.0",
            dependencies: { "dep-b": "*" },
          },
        },
        packages: {
          "dep-a": [
            `dep-a@${dependencyVersion}`,
            "",
            {},
            `sha512-a-${dependencyVersion}`,
          ],
          "dep-b": ["dep-b@1.0.0", "", {}, "sha512-b"],
          tool: [`tool@${toolVersion}`, "", {}, `sha512-tool-${toolVersion}`],
        },
      });
    lock("1.0.0", "1.0.0");
    run(["git", "init", "--quiet"]);
    run(["git", "add", "."]);
    const hashes = () =>
      new Map(
        v
          .parse(
            summarySchema,
            JSON.parse(
              run([
                path.join(root, "node_modules/.bin/turbo"),
                "run",
                "lint",
                "typecheck",
                "--dry=json",
              ]),
            ),
          )
          .tasks.map(({ taskId, hash }) => [taskId, hash]),
      );
    const initial = hashes();
    expect([...initial.keys()].toSorted()).toEqual([
      "a#lint",
      "a#typecheck",
      "b#lint",
      "b#typecheck",
    ]);
    const fingerprint = readFileSync(
      path.join(fixture, "scripts/bun-toolchain.gen.json"),
      "utf-8",
    );
    write("package.json", {
      ...manifest,
      scripts: { unrelated: "echo changed" },
    });
    expect(await generateBunToolchain(fixture, true)).toBe(0);
    expect(
      readFileSync(
        path.join(fixture, "scripts/bun-toolchain.gen.json"),
        "utf-8",
      ),
    ).toBe(fingerprint);
    expect(hashes()).toEqual(initial);

    // Only packageManager changes; dependencies and bun.lock stay identical.
    write("package.json", { ...manifest, packageManager: "bun@1.4.4" });
    expect(await generateBunToolchain(fixture, false)).toBe(1);
    expect(await generateBunToolchain(fixture, true)).toBe(0);
    const pinChanged = hashes();
    for (const [taskId, hash] of initial) {
      expect(pinChanged.get(taskId)).not.toBe(hash);
    }

    // Removing the real production input recreates the old-runtime cache hit.
    write("turbo.json", {
      ...turbo,
      globalDependencies: turbo.globalDependencies?.filter(
        (input) => input !== "scripts/bun-toolchain.gen.json",
      ),
    });
    const unprotected = hashes();
    write("package.json", manifest);
    expect(await generateBunToolchain(fixture, true)).toBe(0);
    expect(hashes()).toEqual(unprotected);
    write("turbo.json", turbo);
    expect(hashes()).toEqual(initial);

    lock("2.0.0", "1.0.0");
    const workspaceChanged = hashes();
    for (const task of ["lint", "typecheck"]) {
      expect(workspaceChanged.get(`a#${task}`)).not.toBe(
        initial.get(`a#${task}`),
      );
      expect(workspaceChanged.get(`b#${task}`)).toBe(initial.get(`b#${task}`));
    }
    lock("2.0.0", "2.0.0");
    const toolChanged = hashes();
    for (const [taskId, hash] of workspaceChanged) {
      expect(toolChanged.get(taskId)).not.toBe(hash);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
