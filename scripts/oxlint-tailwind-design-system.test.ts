import { expect, test } from "bun:test";
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
          ...(readOnly ? { OXLINT_TAILWINDCSS_CACHE_READ_ONLY: "1" } : {}),
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

test("all Tailwind package lint scripts use the shared read-only cache", async () => {
  for (const packagePath of [
    "apps/web/package.json",
    "apps/desktop/package.json",
    "apps/playground/package.json",
    "packages/mcp-apps/package.json",
  ]) {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, packagePath), "utf-8"),
    );
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (
        name !== "lint" &&
        name !== "lint:fix" &&
        !name.startsWith("lint:profile")
      ) {
        continue;
      }
      expect(command).toContain("OXLINT_TAILWINDCSS_CACHE_DIR=.tailwind-cache");
      expect(command).toContain("OXLINT_TAILWINDCSS_CACHE_READ_ONLY=1");
    }
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
