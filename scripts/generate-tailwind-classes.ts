import { panic } from "better-result";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheArtifactPaths } from "oxlint-tailwindcss";
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
 * The diagnostics that mean the Tailwind rules did not run: the design system
 * or its cache was unavailable, or the Tailwind plugin itself threw. Findings
 * of other rules are left to the lint jobs that enforce them.
 */
export const tailwindFailureMessages = (
  messages: readonly string[],
): string[] =>
  [
    ...new Set(
      messages.filter(
        (message) =>
          message.includes("tailwind design system not loaded") ||
          (message.includes("Error running JS plugin") &&
            message.includes("oxlint-tailwindcss")),
      ),
    ),
  ].toSorted();

/** Lints every Tailwind entry point and returns why its rules did not run. */
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
  return tailwindFailureMessages(
    v
      .parse(lintReport, JSON.parse(stdout))
      .diagnostics.map(({ message }) => message),
  );
};

/** Fills `cacheDirectory` from nothing with exactly what the sources need. */
const generate = async (cacheDirectory: string) => {
  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(cacheDirectory, { recursive: true });
  // oxlint.config.ts defaults lint to read-only; generation fills the cache.
  const env = {
    ...process.env,
    OXLINT_TAILWINDCSS_CACHE_DIR: cacheDirectory,
    OXLINT_TAILWINDCSS_CACHE_READ_ONLY: "0",
  };
  const generationFailures = await tailwindFailures(env);
  if (generationFailures.length > 0) {
    panic(
      `Tailwind rules failed while generating the cache:\n${generationFailures.join("\n")}`,
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
  const missing = await tailwindFailures({
    ...env,
    OXLINT_TAILWINDCSS_CACHE_READ_ONLY: "1",
  });
  if (missing.length > 0) {
    panic(
      `Read-only lint misses answers in the generated Tailwind cache:\n${missing.join("\n")}`,
    );
  }
};

/** Cache artifacts by file name. */
export type CacheFiles = ReadonlyMap<string, string>;

const readCache = async (directory: string): Promise<CacheFiles> => {
  const files = new Map<string, string>();
  try {
    for (const name of (await readdir(directory)).toSorted()) {
      if (artifact.test(name)) {
        files.set(name, await readFile(path.join(directory, name), "utf-8"));
      }
    }
  } catch {
    // A missing cache directory holds no artifacts.
  }
  return files;
};

const isDeclarationShard = (name: string) => name.includes(".decl-");

/** Class token → its answer as JSON; own properties only, so any token is safe. */
const answersOf = (text: string | undefined) => {
  if (text === undefined) {
    return new Map<string, string>();
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new Map<string, string>();
  }
  return new Map(
    Object.entries(parsed).map(([token, answer]) => [
      token,
      JSON.stringify(answer),
    ]),
  );
};

/**
 * Why the committed cache cannot serve lint, decided without compiling. The
 * plugin names each snapshot by the hash of what compiles it (the stylesheet
 * and its imports, their package versions, the Tailwind engine and the
 * plugin's precompute script), so a committed file of that name is current.
 * A class without an answer fails every read-only lint that meets it.
 */
export const snapshotProblems = (committed: ReadonlySet<string>) =>
  [
    ...new Set(
      tailwindEntryPoints.flatMap(({ stylesheet }) => {
        const name = path.basename(
          cacheArtifactPaths(path.join(repositoryRoot, stylesheet)).json,
        );
        return committed.has(name)
          ? []
          : [`- ${stylesheet}: design-system snapshot ${name} missing`];
      }),
    ),
  ].toSorted();

/** The cache check: digests only, so it never starts lint or a worker. */
export const checkCache = async () =>
  snapshotProblems(new Set(await readdir(committedCache)));

/**
 * The committed cache after a generation. Fresh answers win; an answer the
 * sources no longer use stays, because a concurrent change may use that class
 * again; only artifacts of a snapshot that is no longer generated go.
 */
export const mergeCache = (
  committed: CacheFiles,
  generated: CacheFiles,
): Map<string, string> => {
  const currentSnapshots = new Set(
    [...generated.keys()].map((name) => name.slice(0, 32)),
  );
  const merged = new Map<string, string>();
  for (const [name, text] of committed) {
    if (isDeclarationShard(name) && currentSnapshots.has(name.slice(0, 32))) {
      merged.set(name, text);
    }
  }
  for (const [name, text] of generated) {
    if (!isDeclarationShard(name)) {
      merged.set(name, text);
      continue;
    }
    const answers = answersOf(merged.get(name));
    for (const [token, answer] of answersOf(text)) {
      answers.set(token, answer);
    }
    // Code-unit order, so the bytes do not depend on the machine's locale.
    const sorted = [...answers].toSorted(([left], [right]) =>
      left < right ? -1 : 1,
    );
    merged.set(
      name,
      `${JSON.stringify(
        Object.fromEntries(
          sorted.map(([token, answer]) => [token, JSON.parse(answer)]),
        ),
      )}\n`,
    );
  }
  return merged;
};

const write = async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "stella-tailwind-cache-"),
  );
  try {
    await generate(temporaryRoot);
    const merged = mergeCache(
      await readCache(committedCache),
      await readCache(temporaryRoot),
    );
    await mkdir(committedCache, { recursive: true });
    for (const name of await readdir(committedCache)) {
      if (!merged.has(name)) {
        await rm(path.join(committedCache, name), {
          recursive: true,
          force: true,
        });
      }
    }
    for (const [name, text] of merged) {
      await Bun.write(path.join(committedCache, name), text);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const check = async () => {
  const problems = await checkCache();
  if (problems.length > 0) {
    process.stderr.write(
      `Tailwind cache is stale:\n${problems.join("\n")}\nRun bun scripts/generate-tailwind-classes.ts --write and commit .tailwind-cache.\n`,
    );
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "--write") {
    await write();
  } else if (mode === "--check") {
    await check();
  } else {
    panic("Usage: generate-tailwind-classes.ts --write|--check");
  }
}
