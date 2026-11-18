import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runCheck = async (args: string[]) => {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("i18n-check.ts", import.meta.url)),
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
};

test("unused-key checks combine every repeated source directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "i18n-sources-"));
  const locales = path.join(directory, "locales");
  const app = path.join(directory, "app");
  const catalog = path.join(directory, "catalog");
  try {
    await Promise.all(
      [locales, app, catalog].map(async (sourceDirectory) => {
        await mkdir(sourceDirectory);
      }),
    );
    const english = {
      app: "Application action",
      rationale: "Model rationale",
    };
    await Promise.all([
      writeFile(path.join(locales, "en.json"), JSON.stringify(english)),
      // Every catalog carries a source lock; this one matches its English.
      writeFile(
        path.join(directory, "i18n-source-lock.json"),
        JSON.stringify(english),
      ),
      writeFile(path.join(app, "view.ts"), 'const action = "app";'),
      writeFile(
        path.join(catalog, "models.ts"),
        'const rationaleKey = "rationale";',
      ),
    ]);

    const missingCatalog = await runCheck([locales, `--unused-in=${app}`]);
    expect(missingCatalog.exitCode).toBe(1);
    expect(missingCatalog.output).toContain("rationale");

    const allSources = await runCheck([
      locales,
      `--unused-in=${app}`,
      `--unused-in=${catalog}`,
    ]);
    expect(allSources).toMatchObject({ exitCode: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("structural sync and untranslated baseline keep sorted catalog output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "i18n-records-"));
  const langs = path.join(directory, "langs");
  try {
    await mkdir(langs);
    const english = { z: "Last caption", a: { caption: "First caption" } };
    await writeFile(path.join(langs, "en.json"), JSON.stringify(english));
    for (const locale of ["fr", "de"]) {
      await writeFile(
        path.join(langs, `${locale}.json`),
        JSON.stringify({ z: "Last caption", obsolete: "Remove" }),
      );
    }
    const synced = await runCheck([langs, "--sync"]);
    expect(synced.exitCode, synced.output).toBe(0);
    const expected = `${JSON.stringify({ a: { caption: "First caption" }, z: "Last caption" }, null, 2)}\n`;
    expect(await readFile(path.join(langs, "de.json"), "utf-8")).toBe(expected);
    expect(await readFile(path.join(langs, "fr.json"), "utf-8")).toBe(expected);
    const baseline = await runCheck([langs, "--write-baseline"]);
    expect(baseline.exitCode, baseline.output).toBe(0);
    expect(baseline.output).toContain("2 untranslated keys (4 locale entries)");
    expect(
      await readFile(path.join(directory, "i18n-check-baseline.json"), "utf-8"),
    ).toBe(
      `${JSON.stringify(
        {
          duplicatesCommon: [],
          duplicateValues: [],
          identicalToSource: { "a.caption": ["de", "fr"], z: ["de", "fr"] },
          unusedKeys: [],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
