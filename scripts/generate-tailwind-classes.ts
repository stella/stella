import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  cacheArtifactPaths,
  writeDeclarationAnswers,
  writeDesignSystemSnapshot,
} from "oxlint-tailwindcss";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import oxlintConfig from "../oxlint.config.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const generatedCache = path.join(repositoryRoot, ".tailwind-cache");
const staleLockAgeMs = 5 * 60_000;
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
const stylesheets = [
  ...new Set(tailwindEntryPoints.map(({ stylesheet }) => stylesheet)),
].toSorted();
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

/**
 * How long one oxlint pass over the Tailwind sources may run. A pass takes
 * well under a minute on a CI runner; one still running after this has
 * stalled, and is stopped so the step fails instead of hanging.
 */
export const lintPassTimeoutMs = 5 * 60_000;

/**
 * What a process's threads are waiting in, for a stall message: each
 * thread's name, scheduler state and kernel wait channel, from /proc.
 */
export const describeThreads = (pid: number) => {
  const readProc = (file: string) => {
    try {
      return readFileSync(file, "utf-8");
    } catch {
      // The process or thread can exit while it is being read.
      return "";
    }
  };
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return "its threads could not be read on this system";
  }
  const states = new Map<string, number>();
  for (const task of tasks) {
    const directory = `/proc/${pid}/task/${task}`;
    const stat = readProc(`${directory}/stat`);
    const wchan = readProc(`${directory}/wchan`);
    const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
    const key = `${name} ${state}${wchan === "" || wchan === "0" ? "" : ` in ${wchan}`}`;
    states.set(key, (states.get(key) ?? 0) + 1);
  }
  return `its ${tasks.length} threads were ${[...states]
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, count]) => `${count}x ${key}`)
    .join(", ")}`;
};

/**
 * Runs one lint pass and returns its exit code and report. The report is read
 * while the pass runs, so a large one cannot fill the pipe and block it. A
 * pass still running after `timeoutMs` is killed and fails generation with a
 * message naming the pass, how much of its report it had written, and what
 * its threads were waiting in.
 */
export const runLintPass = async (
  command: readonly string[],
  {
    env,
    pass,
    timeoutMs = lintPassTimeoutMs,
  }: {
    env: Record<string, string | undefined>;
    pass: string;
    timeoutMs?: number;
  },
): Promise<{ exitCode: number; stdout: string }> => {
  const child = Bun.spawn([...command], {
    cwd: repositoryRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const chunks: Uint8Array[] = [];
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      chunks.push(chunk);
    }
  })();
  const stall: { threads?: string } = {};
  const timer = setTimeout(() => {
    stall.threads = describeThreads(child.pid);
    child.kill("SIGKILL");
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  await reading;
  const stdout = Buffer.concat(chunks);
  if (stall.threads !== undefined) {
    panic(
      `Tailwind cache generation (scripts/generate-tailwind-classes.ts --write): the ${pass} oxlint pass was still running after ${timeoutMs / 1000} s and was stopped. It had written ${stdout.byteLength} bytes of its report, and ${stall.threads}. Generation starts no Tailwind worker in a lint pass, so the pass was not waiting on one. Run the command locally to reproduce: ${command.join(" ")}`,
    );
  }
  return { exitCode, stdout: stdout.toString("utf-8") };
};

/**
 * Fails generation with `what` once `work` has run as long as a lint pass may.
 * The work runs in this thread, so it holds no lock and waits on no other
 * thread; this only names it if it never settles.
 */
const withinPassTime = async <T>(what: string, work: Promise<T>) => {
  const timer: { id?: ReturnType<typeof setTimeout> } = {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer.id = setTimeout(() => {
          reject(
            new Error(
              `Tailwind cache generation (scripts/generate-tailwind-classes.ts --write): ${what} had not finished after ${lintPassTimeoutMs / 1000} s.`,
            ),
          );
        }, lintPassTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer.id);
  }
};

/**
 * Lints every Tailwind entry point and returns why its rules did not run. The
 * pass runs only the Tailwind rules (oxlint.tailwind.config.ts), which ask the
 * design system for the same classes as the repository lint. Oxlint's own
 * entry runs in this Bun process's runtime directly, so a timeout kills the
 * whole pass; `bun --bun oxlint` would start it under a wrapper process.
 */
const tailwindFailures = async (
  env: Record<string, string | undefined>,
  pass: string,
) => {
  const { exitCode, stdout } = await runLintPass(
    [
      process.execPath,
      path.join(repositoryRoot, "node_modules/oxlint/bin/oxlint"),
      "-c",
      "oxlint.tailwind.config.ts",
      "--format",
      "json",
      ...lintTargets,
    ],
    { env, pass },
  );
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

const collectedLine = v.object({
  cssPath: v.string(),
  classes: v.array(v.string()),
});

/**
 * The classes a collecting lint pass found without a declaration answer, by
 * stylesheet, from the lines the plugin appended (one JSON object per line).
 * Sorted, so the answers are computed and written in the same order every run.
 */
export const parseCollectedClasses = (text: string) => {
  const byStylesheet = new Map<string, Set<string>>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const { cssPath, classes } = v.parse(collectedLine, JSON.parse(line));
    const known = byStylesheet.get(cssPath) ?? new Set<string>();
    for (const name of classes) {
      known.add(name);
    }
    byStylesheet.set(cssPath, known);
  }
  return new Map(
    [...byStylesheet]
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([cssPath, classes]) => [cssPath, [...classes].toSorted()]),
  );
};

/**
 * Lint passes per generation. A pass asks only about classes in the sources,
 * so the second normally finds every answer; a pass still missing answers
 * after this many means they do not converge.
 */
const collectingPassLimit = 4;

/**
 * Fills `cacheDirectory` from nothing with exactly what the sources need.
 *
 * Generation starts no Tailwind worker thread. A lint pass that starts them
 * blocks oxlint's only JavaScript thread on each worker's answer, and that is
 * the pass that stalled. The snapshots and declaration answers are computed
 * here instead, in this script's own thread. Every lint pass is read-only, as
 * repository lint is, and writes down the classes it has no answer for; those
 * are answered and the pass runs again, until one finds every answer. That
 * last pass is the read-only check that lint can use the cache.
 */
const generate = async (cacheDirectory: string) => {
  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(cacheDirectory, { recursive: true });
  for (const stylesheet of stylesheets) {
    const snapshot = await withinPassTime(
      `compiling the design system of ${stylesheet}`,
      writeDesignSystemSnapshot(
        path.join(repositoryRoot, stylesheet),
        cacheDirectory,
      ),
    );
    // Timings differ on every compile; the cache keeps only the answers.
    const value = JSON.parse(await readFile(snapshot, "utf-8"));
    delete value.timings;
    await Bun.write(snapshot, `${JSON.stringify(value)}\n`);
  }
  const collected = path.join(cacheDirectory, "collected-classes.jsonl");
  const env = {
    ...process.env,
    OXLINT_TAILWINDCSS_CACHE_DIR: cacheDirectory,
    OXLINT_TAILWINDCSS_CACHE_READ_ONLY: "1",
    OXLINT_TAILWINDCSS_CACHE_COLLECT: collected,
  };
  for (let round = 1; ; round += 1) {
    await rm(collected, { force: true });
    const failures = await tailwindFailures(env, `read-only ${round}`);
    if (failures.length > 0) {
      panic(
        `Tailwind rules failed while generating the cache:\n${failures.join("\n")}`,
      );
    }
    const missing = parseCollectedClasses(
      await readFile(collected, "utf-8").catch(() => ""),
    );
    if (missing.size === 0) {
      break;
    }
    if (round === collectingPassLimit) {
      panic(
        `Read-only lint misses answers in the generated Tailwind cache after ${round} passes: ${[
          ...missing,
        ]
          .map(
            ([cssPath, classes]) =>
              `${repoRelativePath(repositoryRoot, cssPath)} (${classes.slice(0, 5).join(" ")})`,
          )
          .join(", ")}`,
      );
    }
    for (const [cssPath, classes] of missing) {
      await withinPassTime(
        `answering ${classes.length} classes for ${repoRelativePath(repositoryRoot, cssPath)}`,
        writeDeclarationAnswers(cssPath, classes, cacheDirectory),
      );
    }
  }
  for (const name of await readdir(cacheDirectory)) {
    if (!artifact.test(name)) {
      await rm(path.join(cacheDirectory, name), {
        recursive: true,
        force: true,
      });
    }
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
 * Why the generated cache cannot serve lint, decided without compiling. The
 * plugin names each snapshot by the hash of what compiles it (the stylesheet
 * and its imports, including workspace stylesheets imported by package name
 * such as `@stll/ui/theme.css`, the installed packages' versions, the Tailwind
 * engine and the plugin's precompute script), so a committed file of that name
 * is current.
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
export const checkCache = async () => {
  try {
    return snapshotProblems(new Set(await readdir(generatedCache)));
  } catch {
    return snapshotProblems(new Set());
  }
};

/**
 * A cache merged after generation. Fresh answers win; an answer the
 * sources no longer use stays, because a concurrent change may use that class
 * again; only artifacts of a snapshot that is no longer generated go.
 */
export const mergeCache = (
  existing: CacheFiles,
  generated: CacheFiles,
): Map<string, string> => {
  const currentSnapshots = new Set(
    [...generated.keys()].map((name) => name.slice(0, 32)),
  );
  const merged = new Map<string, string>();
  for (const [name, text] of existing) {
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

const lockValue = (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !("token" in value) ||
    typeof value.token !== "string"
  ) {
    return undefined;
  }
  return { createdAt: value.createdAt, pid: value.pid, token: value.token };
};

const acquireLock = async (cacheLock: string, token: string) => {
  while (true) {
    try {
      const lock = await open(cacheLock, "wx");
      await lock.writeFile(
        JSON.stringify({ createdAt: Date.now(), pid: process.pid, token }),
      );
      await lock.close();
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      let staleToken: string | undefined;
      try {
        const value = lockValue(JSON.parse(await readFile(cacheLock, "utf-8")));
        if (value && Date.now() - value.createdAt > staleLockAgeMs) {
          staleToken = value.token;
        } else if (value) {
          try {
            process.kill(value.pid, 0);
          } catch {
            staleToken = value.token;
          }
        }
      } catch {
        // A writer may be between creating and filling its lock file.
      }
      if (staleToken !== undefined) {
        const current = lockValue(
          JSON.parse(await readFile(cacheLock, "utf-8")),
        );
        if (current?.token === staleToken) {
          await rm(cacheLock, { force: true });
        }
      } else {
        await Bun.sleep(50);
      }
    }
  }
};

export const writeCache = async (cacheDirectory = generatedCache) => {
  const cacheLock = `${cacheDirectory}.lock`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  await acquireLock(cacheLock, token);

  const temporaryRoot = await mkdtemp(
    path.join(path.dirname(cacheDirectory), ".tailwind-cache-build-"),
  );
  try {
    await generate(temporaryRoot);
    const generated = await readCache(temporaryRoot);
    const merged = mergeCache(await readCache(cacheDirectory), generated);
    const current = await readCache(cacheDirectory);
    if (
      current.size === merged.size &&
      [...merged].every(([name, text]) => current.get(name) === text)
    ) {
      return;
    }
    await mkdir(cacheDirectory, { recursive: true });
    for (const [name, text] of merged) {
      const temporaryFile = path.join(temporaryRoot, `.publish-${name}`);
      await Bun.write(temporaryFile, text);
      await rename(temporaryFile, path.join(cacheDirectory, name));
    }
    for (const name of await readdir(cacheDirectory)) {
      if (artifact.test(name) && !merged.has(name)) {
        await rm(path.join(cacheDirectory, name), { force: true });
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    try {
      const current: unknown = JSON.parse(await readFile(cacheLock, "utf-8"));
      if (
        typeof current === "object" &&
        current !== null &&
        "token" in current &&
        current.token === token
      ) {
        await rm(cacheLock, { force: true });
      }
    } catch {
      // The lock was already removed or replaced after becoming stale.
    }
  }
};

const check = async () => {
  const problems = await checkCache();
  if (problems.length > 0) {
    process.stderr.write(
      `Tailwind cache is missing or stale:\n${problems.join("\n")}\nRun bun scripts/generate-tailwind-classes.ts --write.\n`,
    );
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "--write") {
    await writeCache();
  } else if (mode === "--check") {
    await check();
  } else {
    panic("Usage: generate-tailwind-classes.ts --write|--check");
  }
}
