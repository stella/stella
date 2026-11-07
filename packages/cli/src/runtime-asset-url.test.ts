import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCapabilityCatalog } from "./capability-catalog-data.js";

// Exercise the virtual filesystem in the compiled runtime: source execution
// cannot detect module URLs being flattened by Bun's bundler.
// timeout: compiling and launching the executable needs compiler and process startup time.
test("standalone executables carry the capability catalog and registry snapshot", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-bundled-assets-"),
  );
  const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
  const catalogModule = fileURLToPath(
    new URL("capability-catalog-load.ts", import.meta.url),
  );
  const registryModule = fileURLToPath(
    new URL("registry-refresh.ts", import.meta.url),
  );
  const resultModule = fileURLToPath(import.meta.resolve("better-result"));
  const snapshotUrl = new URL(
    "generated/registry-snapshot.json",
    import.meta.url,
  );
  const snapshot: unknown = JSON.parse(await readFile(snapshotUrl, "utf-8"));
  if (!Array.isArray(snapshot)) {
    throw new TypeError("Expected registry array");
  }
  const entrypoint = path.join(directory, "entry.ts");
  const executable = path.join(
    directory,
    process.platform === "win32" ? "assets.exe" : "assets",
  );
  try {
    await writeFile(
      entrypoint,
      `import { Result } from ${JSON.stringify(resultModule)};
import { loadBakedCapabilityCatalog } from ${JSON.stringify(catalogModule)};
import { refreshRegistryCache } from ${JSON.stringify(registryModule)};
const refreshed = await refreshRegistryCache({
  serverOrigin: "https://example.invalid",
  token: "fixture",
  env: { XDG_CACHE_HOME: process.cwd() },
  now: 0,
  force: true,
  fetchRaw: async () => Result.ok({ rawBody: JSON.stringify({ result: { tools: [] } }) }),
});
if (refreshed.status !== "refreshed") throw new TypeError("Expected refreshed registry");
const catalog = loadBakedCapabilityCatalog();
if (catalog === null) throw new TypeError("Expected bundled capability catalog");
process.stdout.write(JSON.stringify({ capabilities: catalog.length, removedTools: refreshed.registry.delta.removed.length }));
`,
    );
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        entrypoint,
        "--compile",
        `--outfile=${executable}`,
        "--asset",
        "capabilities",
        "--asset",
        "src/generated/registry-snapshot.json",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
      ],
      { cwd: packageDirectory },
    );
    expect(build.stderr.toString()).not.toContain("error:");
    expect(build.exitCode).toBe(0);
    const result = Bun.spawnSync([executable], { cwd: directory });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      capabilities: readCapabilityCatalog().length,
      removedTools: snapshot.length,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
