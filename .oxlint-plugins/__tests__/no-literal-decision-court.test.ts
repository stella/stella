import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const RULE_ID = "no-literal-decision-court/no-literal-decision-court";
const temporaryDirectories: string[] = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

type LintRun = { exitCode: number; output: string };

/** Lint one source through the rule alone, as the adapters glob enables it. */
const lint = async (source: string): Promise<LintRun> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-oxlint-decision-court-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      jsPlugins: [
        path.join(
          REPOSITORY_ROOT,
          ".oxlint-plugins",
          "no-literal-decision-court.ts",
        ),
      ],
      rules: { [RULE_ID]: "error" },
    })};\n`,
  );
  const sourcePath = path.join(directory, "adapter.ts");
  await Bun.write(sourcePath, source);

  const spawned = Bun.spawn(
    [process.execPath, "--bun", "oxlint", "-c", configPath, sourcePath],
    { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    spawned.exited,
    new Response(spawned.stderr).text(),
    new Response(spawned.stdout).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
};

const reportedLines = (output: string): number[] =>
  Array.from(
    output.matchAll(
      /adapter\.ts:(?<line>\d+):\d+: error no-literal-decision-court/gu,
    ),
    (match) => Number(match.groups?.line),
  );

describe.serial("no-literal-decision-court", () => {
  test("reports every court an adapter states for itself", async () => {
    const source = [
      `const row = { court: "Nejvyšší soud" };`,
      `const asserted = { court: "Ústavní soud" as const };`,
      `const metadata = { metadata: { court: \`RIS \${application}\` } };`,
      `parseDecisionHtml({ caseNumber, court: "Nejvyšší správní soud" });`,
      "",
    ].join("\n");

    const { exitCode, output } = await lint(source);

    expect(exitCode).toBe(1);
    // One report per stated court: the row, the asserted literal, the
    // metadata mirror, and the parser argument that carries the same
    // attribution into the stored document.
    expect(reportedLines(output)).toEqual([1, 2, 3, 4]);
  });

  test("accepts a court resolved from the decision's own record", async () => {
    const source = [
      "const court = czDecisionCourt({ adapterKey, ecli, publisherCourt, sourceDocumentId });",
      "const row = { court, metadata: { court } };",
      "const stated = { court: item.sud?.nazov };",
      "const reparsed = { court: stored.court };",
      "const listed = { court: statedCourt ?? publisherCourt };",
      // A court-valued query parameter filters a listing; it attributes
      // nothing, and is named for what it filters.
      `fetchListing({ courtFilter: "AUSL" });`,
      "type Detail = { court: string };",
      "",
    ].join("\n");

    const { exitCode, output } = await lint(source);

    expect(output).not.toContain(RULE_ID);
    expect(exitCode).toBe(0);
  });
});
