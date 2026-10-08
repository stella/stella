import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("unused-key checks combine every repeated source directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "i18n-sources-"));
  const locales = path.join(directory, "locales");
  const app = path.join(directory, "app");
  const catalog = path.join(directory, "catalog");
  try {
    await Promise.all(
      [locales, app, catalog].map((sourceDirectory) => mkdir(sourceDirectory)),
    );
    await Promise.all([
      writeFile(
        path.join(locales, "en.json"),
        JSON.stringify({
          app: "Application action",
          rationale: "Model rationale",
        }),
      ),
      writeFile(path.join(app, "view.ts"), 'const action = "app";'),
      writeFile(
        path.join(catalog, "models.ts"),
        'const rationaleKey = "rationale";',
      ),
    ]);
    const check = async (sourceDirectories: string[]) => {
      const subprocess = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("i18n-check.ts", import.meta.url)),
          locales,
          ...sourceDirectories.map(
            (sourceDirectory) => `--unused-in=${sourceDirectory}`,
          ),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      return { exitCode, output: stdout + stderr };
    };

    const missingCatalog = await check([app]);
    expect(missingCatalog.exitCode).toBe(1);
    expect(missingCatalog.output).toContain("rationale");

    const allSources = await check([app, catalog]);
    expect(allSources).toMatchObject({ exitCode: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
