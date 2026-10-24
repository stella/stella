import { panic } from "better-result";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import oxlintConfig from "../oxlint.config.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const committedCache = path.join(repositoryRoot, ".tailwind-cache");
const tailwindSettings = v.object({
  tailwindcss: v.object({
    entryPoint: v.array(
      v.object({
        files: v.pipe(v.string(), v.endsWith("/**")),
        use: v.string(),
      }),
    ),
  }),
});

/** Every tree the Tailwind rules lint and the stylesheet each one uses. */
export const tailwindEntryPoints = v
  .parse(tailwindSettings, oxlintConfig.settings)
  .tailwindcss.entryPoint.map(({ files, use }) => ({
    root: files.slice(0, -"/**".length),
    stylesheet: use,
  }));
const lintTargets = tailwindEntryPoints.map(({ root }) => root);
const artifact = /^[0-9a-f]{32}(?:\.json|\.decl-[0-9a-f]{2}\.json)$/u;

const lintReport = v.object({
  diagnostics: v.array(v.object({ message: v.string() })),
});

/**
 * Lints every Tailwind entry point and returns its design-system failures.
 * Findings of other rules are left to the lint jobs that enforce them.
 */
const tailwindFailures = async (env: Record<string, string | undefined>) => {
  const child = Bun.spawn(
    [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--format",
      "json",
      ...lintTargets,
    ],
    { cwd: repositoryRoot, env, stdout: "pipe", stderr: "inherit" },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  // oxlint exits 1 when it reports findings; anything else is a crash.
  if (exitCode !== 0 && exitCode !== 1) {
    panic(`oxlint exited with ${exitCode} while linting the Tailwind sources.`);
  }
  const messages = v
    .parse(lintReport, JSON.parse(stdout))
    .diagnostics.map(({ message }) => message)
    .filter((message) => message.includes("tailwind design system not loaded"));
  return [...new Set(messages)].toSorted();
};

const generate = async (cacheDirectory: string) => {
  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(cacheDirectory, { recursive: true });
  const env = {
    ...process.env,
    OXLINT_TAILWINDCSS_CACHE_DIR: cacheDirectory,
  };
  // oxlint.config.ts defaults lint to read-only; generation fills the cache.
  env["OXLINT_TAILWINDCSS_CACHE_READ_ONLY"] = "0";
  const generationFailures = await tailwindFailures(env);
  if (generationFailures.length > 0) {
    panic(
      `Tailwind design system failed to load while generating the cache:\n${generationFailures.join("\n")}`,
    );
  }
  for (const name of await readdir(cacheDirectory)) {
    const file = path.join(cacheDirectory, name);
    if (!artifact.test(name)) {
      await rm(file, { recursive: true, force: true });
      continue;
    }
    const value = JSON.parse(await readFile(file, "utf-8"));
    if (!name.includes(".decl-")) {
      delete value.timings;
    }
    await Bun.write(file, `${JSON.stringify(value)}\n`);
  }
  env["OXLINT_TAILWINDCSS_CACHE_READ_ONLY"] = "1";
  const missing = await tailwindFailures(env);
  if (missing.length > 0) {
    panic(
      `Read-only lint misses answers in the generated Tailwind cache:\n${missing.join("\n")}`,
    );
  }
};

const snapshot = async (directory: string) => {
  const entries = new Map<string, Uint8Array>();
  try {
    for (const name of (await readdir(directory)).toSorted()) {
      entries.set(name, await readFile(path.join(directory, name)));
    }
  } catch {
    // A missing output directory is represented by an empty snapshot.
  }
  return entries;
};

const check = async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "stella-tailwind-cache-"),
  );
  try {
    await generate(temporaryRoot);
    const [expected, actual] = await Promise.all([
      snapshot(committedCache),
      snapshot(temporaryRoot),
    ]);
    const names = new Set([...expected.keys(), ...actual.keys()]);
    const changed = [...names]
      .filter((name) => {
        const left = expected.get(name);
        const right = actual.get(name);
        return !left || !right || !Buffer.from(left).equals(Buffer.from(right));
      })
      .toSorted();
    if (changed.length > 0) {
      panic(
        `Tailwind cache is stale: ${changed.join(", ")}. Run bun scripts/generate-tailwind-classes.ts --write.`,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "--write") {
    await generate(committedCache);
  } else if (mode === "--check") {
    await check();
  } else {
    panic("Usage: generate-tailwind-classes.ts --write|--check");
  }
}
