import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import oxlintConfig from "../oxlint.config.ts";
import {
  checkCache,
  mergeCache,
  snapshotProblems,
  tailwindEntryPoints,
  tailwindFailureMessages,
} from "./generate-tailwind-classes";
import { generatorsForFiles } from "./generated-files";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const pluginPath = path.join(repositoryRoot, "node_modules/oxlint-tailwindcss");
const generatedCache = path.join(repositoryRoot, ".tailwind-cache");
const report = v.object({
  diagnostics: v.array(
    v.object({
      code: v.optional(v.string(), ""),
      message: v.string(),
      severity: v.string(),
    }),
  ),
});

const lintFixture = async ({
  cache,
  source,
  readOnly = true,
}: {
  cache: string;
  source: string;
  readOnly?: boolean;
}) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-tailwind-cache-test-"),
  );
  try {
    const input = path.join(directory, "input.tsx");
    await Bun.write(input, source);
    const config = path.join(directory, "oxlint.config.ts");
    await Bun.write(
      config,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [pluginPath],
        settings: {
          tailwindcss: {
            entryPoint: path.join(
              repositoryRoot,
              "apps/web/src/styles/app.css",
            ),
          },
        },
        rules: {
          "tailwindcss/no-conflicting-classes": "error",
          "tailwindcss/no-deprecated-classes": "error",
          "tailwindcss/no-duplicate-classes": "error",
          "tailwindcss/no-unknown-classes": "error",
        },
      })};`,
    );
    const child = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          OXLINT_TAILWINDCSS_CACHE_DIR: cache,
          OXLINT_TAILWINDCSS_CACHE_READ_ONLY: readOnly ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { ...v.parse(report, JSON.parse(stdout)), stderr, exitCode };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("read-only lint uses the complete committed cache for all Tailwind rules", async () => {
  const result = await lintFixture({
    cache: generatedCache,
    source:
      'export const A = () => <div className="flex flex block flex-shrink-0" />;\n',
  });
  expect(result.stderr).not.toContain("Worker");
  expect(
    result.diagnostics
      .map(({ code }) => code)
      .toSorted((a, b) => {
        if (a === b) {
          return 0;
        }
        return a < b ? -1 : 1;
      }),
  ).toEqual([
    "tailwindcss(no-conflicting-classes)",
    "tailwindcss(no-conflicting-classes)",
    "tailwindcss(no-deprecated-classes)",
    "tailwindcss(no-duplicate-classes)",
  ]);
});

test("concurrent declaration writers merge answers in the same shard", async () => {
  const cache = await mkdtemp(
    path.join(tmpdir(), "stella-tailwind-concurrent-cache-"),
  );
  try {
    await cp(generatedCache, cache, { recursive: true });
    const left = "cache-regression-9";
    const right = "cache-regression-22";
    const shard = createHash("md5").update(left).digest("hex").slice(0, 2);
    const seeded = await lintFixture({
      cache,
      source: `const seed = <div className="${left}" />;`,
      readOnly: false,
    });
    expect(seeded.exitCode).toBe(1);
    let shardFile: string | undefined;
    for (const name of await readdir(cache)) {
      if (!name.endsWith(`.decl-${shard}.json`)) {
        continue;
      }
      const candidate = path.join(cache, name);
      if ((await readFile(candidate, "utf-8")).includes(JSON.stringify(left))) {
        shardFile = candidate;
        break;
      }
    }
    if (shardFile === undefined) {
      throw new TypeError("Tailwind shard missing");
    }
    await rm(shardFile, { force: true });
    await writeFile(`${shardFile}.lock`, "");
    const writes = Promise.all([
      lintFixture({
        cache,
        source: `const a = <div className="${left}" />;`,
        readOnly: false,
      }),
      lintFixture({
        cache,
        source: `const b = <div className="${right}" />;`,
        readOnly: false,
      }),
    ]);
    await Bun.sleep(1500);
    await unlink(`${shardFile}.lock`);
    const results = await writes;
    expect(results.map(({ exitCode }) => exitCode)).toEqual([1, 1]);
    const persisted = JSON.parse(await readFile(shardFile, "utf-8"));
    expect(Object.keys(persisted)).toContain(left);
    expect(Object.keys(persisted)).toContain(right);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("answers for classes named like object properties persist and reload", async () => {
  const cache = await mkdtemp(
    path.join(tmpdir(), "stella-tailwind-prototype-cache-"),
  );
  try {
    await cp(generatedCache, cache, { recursive: true });
    const source =
      'const a = <div className="constructor toString __proto__" />;';
    const generated = await lintFixture({ cache, source, readOnly: false });
    const reloaded = await lintFixture({ cache, source });
    for (const result of [generated, reloaded]) {
      expect(
        result.diagnostics.filter(
          ({ message }) =>
            message.includes("Error running JS plugin") ||
            message.includes("tailwind design system not loaded"),
        ),
      ).toEqual([]);
    }
    const answers = new Map<string, unknown>();
    for (const name of await readdir(cache)) {
      if (name.includes(".decl-")) {
        for (const [token, answer] of Object.entries(
          JSON.parse(await readFile(path.join(cache, name), "utf-8")),
        )) {
          answers.set(token, answer);
        }
      }
    }
    expect(answers.get("constructor")).toEqual({
      valid: false,
      declarations: [],
      values: {},
    });
    for (const token of ["toString", "__proto__"]) {
      expect({ token, answer: answers.get(token) }).toEqual({
        token,
        answer: { valid: false, declarations: [], values: {} },
      });
    }
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

const snapshotA = `${"a".repeat(32)}.json`;
const shardA = `${"a".repeat(32)}.decl-00.json`;
const shard = (answers: Record<string, unknown>) =>
  `${JSON.stringify(answers)}\n`;

test("the cache check compares digests and never compiles", async () => {
  // Every compile starts a lint child process; the check starts none.
  const spawn = spyOn(Bun, "spawn");
  const spawnSync = spyOn(Bun, "spawnSync");
  try {
    expect(await checkCache()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    spawnSync.mockRestore();
  }
});

test("the cache check names each stylesheet whose snapshot is missing", async () => {
  const committed = await readdir(generatedCache);
  const shards = new Set(committed.filter((name) => name.includes(".decl-")));
  const stylesheets = [
    ...new Set(tailwindEntryPoints.map(({ stylesheet }) => stylesheet)),
  ];
  expect(
    snapshotProblems(shards).map((problem) => problem.split(":")[0]),
  ).toEqual(stylesheets.map((stylesheet) => `- ${stylesheet}`).toSorted());
});

test("every Tailwind entry point is linted by the Tailwind rules", () => {
  // A mapping no rule reads names a snapshot lint never loads, so the
  // generator never writes it and the cache check would demand it.
  const linted = oxlintConfig.overrides.flatMap(({ files, rules }) =>
    Object.keys(rules ?? {}).some((rule) => rule.startsWith("tailwindcss/"))
      ? files
      : [],
  );
  for (const { root } of tailwindEntryPoints) {
    expect({
      root,
      linted: linted.some((glob) => glob.startsWith(`${root}/`)),
    }).toEqual({ root, linted: true });
  }
});

test("the cache write keeps unused answers and drops obsolete snapshots", () => {
  const obsolete = "b".repeat(32);
  const merged = mergeCache(
    new Map([
      [`${obsolete}.json`, '{"v":0}\n'],
      [`${obsolete}.decl-00.json`, shard({ "w-[1px]": { valid: true } })],
      [snapshotA, '{"v":0}\n'],
      [
        shardA,
        shard({ "w-[1px]": { valid: false }, "w-[9px]": { valid: true } }),
      ],
      [`${"a".repeat(32)}.decl-ff.json`, shard({ "h-[9px]": { valid: true } })],
    ]),
    new Map([
      [snapshotA, '{"v":1}\n'],
      [
        shardA,
        shard({ "w-[1px]": { valid: true }, "w-[2px]": { valid: true } }),
      ],
    ]),
  );
  expect(Object.fromEntries(merged)).toEqual({
    [shardA]: shard({
      "w-[1px]": { valid: true },
      "w-[2px]": { valid: true },
      "w-[9px]": { valid: true },
    }),
    [`${"a".repeat(32)}.decl-ff.json`]: shard({ "h-[9px]": { valid: true } }),
    [snapshotA]: '{"v":1}\n',
  });
});

test("a crash inside the Tailwind plugin fails generation", () => {
  const crash =
    "Error running JS plugin.\nTypeError: boom\n    at ask (/repo/node_modules/oxlint-tailwindcss/dist/index.cjs:1:1)";
  expect(
    tailwindFailureMessages([
      crash,
      "Error running JS plugin.\nTypeError: other\n    at rule (/repo/.oxlint-plugins/other.ts:1:1)",
      "tailwind design system not loaded: Tailwind cache is incomplete",
      "Unused oxlint-disable directive",
      crash,
    ]),
  ).toEqual([
    crash,
    "tailwind design system not loaded: Tailwind cache is incomplete",
  ]);
});

test("oxlint.config.ts makes every lint read the committed cache", () => {
  const cacheEnv = (overrides: Record<string, string>) => {
    const child = Bun.spawnSync(
      [
        "bun",
        "-e",
        'await import("./oxlint.config.ts"); console.log(JSON.stringify([process.env.OXLINT_TAILWINDCSS_CACHE_DIR, process.env.OXLINT_TAILWINDCSS_CACHE_READ_ONLY]));',
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !name.startsWith("OXLINT_TAILWINDCSS_CACHE_"),
            ),
          ),
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString());
  };
  expect(cacheEnv({})).toEqual([generatedCache, "1"]);
  expect(
    cacheEnv({
      OXLINT_TAILWINDCSS_CACHE_DIR: "/generation",
      OXLINT_TAILWINDCSS_CACHE_READ_ONLY: "0",
    }),
  ).toEqual(["/generation", "0"]);
});

test("the repository lint refuses a missing cache without any env", async () => {
  const cache = await mkdtemp(path.join(tmpdir(), "stella-tailwind-empty-"));
  try {
    const child = Bun.spawn(
      [
        "bun",
        "--bun",
        "oxlint",
        "-c",
        "oxlint.config.ts",
        "--format",
        "json",
        "apps/playground/src/App.tsx",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name !== "OXLINT_TAILWINDCSS_CACHE_READ_ONLY",
            ),
          ),
          OXLINT_TAILWINDCSS_CACHE_DIR: cache,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    const messages = v
      .parse(report, JSON.parse(stdout))
      .diagnostics.map(({ message }) => message);
    expect(
      messages.some((message) =>
        message.includes("Tailwind cache is incomplete: missing snapshot"),
      ),
    ).toBe(true);
    expect(await readdir(cache)).toEqual([]);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("the cache generator owns every Tailwind entry point", () => {
  const selects = (file: string) =>
    generatorsForFiles([file]).some(({ id }) => id === "tailwind-class-cache");
  expect(tailwindEntryPoints.map(({ root }) => root)).toContain("apps/landing");
  for (const { root, stylesheet } of tailwindEntryPoints) {
    for (const file of [
      stylesheet,
      `${root}/src/example.tsx`,
      `${root}/package.json`,
    ]) {
      expect({ file, selected: selects(file) }).toEqual({
        file,
        selected: true,
      });
    }
  }
  for (const file of ["oxlint.config.ts", "packages/ui/src/styles/theme.css"]) {
    expect({ file, selected: selects(file) }).toEqual({ file, selected: true });
  }
});

test("committed cache keeps the generator's compact form", async () => {
  // The generator writes compact JSON; a formatter rewriting these files on
  // commit would make every --check report them stale.
  const names = await readdir(generatedCache);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const text = await readFile(path.join(generatedCache, name), "utf-8");
    expect({ name, text }).toEqual({
      name,
      text: `${JSON.stringify(JSON.parse(text))}\n`,
    });
  }
});

test("read-only lint reports a missing snapshot once per design-system rule", async () => {
  const cache = await mkdtemp(
    path.join(tmpdir(), "stella-tailwind-empty-cache-"),
  );
  try {
    const result = await lintFixture({
      cache,
      source: 'export const A = () => <div className="flex p-2 text-sm" />;\n',
    });
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toHaveLength(2);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message).toContain(
        "bun scripts/generate-tailwind-classes.ts --write",
      );
    }
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("read-only branches reject worker fallback", async () => {
  const patch = await readFile(
    path.join(repositoryRoot, "patches/oxlint-tailwindcss@1.16.0.patch"),
    "utf-8",
  );
  expect(patch).toContain(
    "if (CACHE_READ_ONLY) throw readOnlyCacheError(`missing snapshot",
  );
  expect(patch).toContain(
    "if (CACHE_READ_ONLY) throw this.remember(cssPath, readOnlyCacheError",
  );
  expect(patch).toContain(
    "if (CACHE_READ_ONLY) throw readOnlyCacheError(`missing declaration answer",
  );
});
