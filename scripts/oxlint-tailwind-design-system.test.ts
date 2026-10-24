import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const pluginPath = path.join(repositoryRoot, "node_modules/oxlint-tailwindcss");
const generatedCache = path.join(repositoryRoot, "apps/web/.tailwind-cache");
const report = v.object({
  diagnostics: v.array(
    v.object({ code: v.string(), message: v.string(), severity: v.string() }),
  ),
});

const lintFixture = async ({
  cache,
  source,
}: {
  cache: string;
  source: string;
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
          OXLINT_TAILWINDCSS_CACHE_READ_ONLY: "1",
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
  expect(result.diagnostics.map(({ code }) => code).toSorted()).toEqual([
    "tailwindcss(no-conflicting-classes)",
    "tailwindcss(no-conflicting-classes)",
    "tailwindcss(no-deprecated-classes)",
    "tailwindcss(no-duplicate-classes)",
  ]);
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
