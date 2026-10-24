import { panic } from "better-result";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const committedCache = path.join(repositoryRoot, "apps/web/.tailwind-cache");
const artifact = /^[0-9a-f]{32}(?:\.json|\.decl-[0-9a-f]{2}\.json)$/u;

const generate = async (cacheDirectory: string) => {
  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(cacheDirectory, { recursive: true });
  const env = { ...process.env };
  delete env["OXLINT_TAILWINDCSS_CACHE_READ_ONLY"];
  env["OXLINT_TAILWINDCSS_CACHE_DIR"] = cacheDirectory;
  const child = Bun.spawn(
    [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--report-unused-disable-directives-severity=error",
      "--type-aware",
      "--type-check",
      "apps/web",
    ],
    { cwd: repositoryRoot, env, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    panic(`Web lint failed while generating Tailwind cache (${exitCode})`);
  }
  for (const name of await readdir(cacheDirectory)) {
    const file = path.join(cacheDirectory, name);
    if (!artifact.test(name)) {
      await rm(file, { recursive: true, force: true });
      continue;
    }
    if (!name.includes(".decl-")) {
      const snapshot = JSON.parse(await readFile(file, "utf-8"));
      delete snapshot.timings;
      await Bun.write(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
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

const mode = process.argv[2];
if (mode === "--write") {
  await generate(committedCache);
} else if (mode === "--check") {
  await check();
} else {
  panic("Usage: generate-tailwind-classes.ts --write|--check");
}
