import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const RULE_NAME = "no-literal-decision-court";
const RULE_ID = `${RULE_NAME}/${RULE_NAME}`;
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

/** One oxlint diagnostic, in the shape `--format=json` reports it. */
type Diagnostic = {
  code: string;
  labels?: readonly { span?: { line?: number } | undefined }[] | undefined;
};

/**
 * The lines this rule reported, in order.
 *
 * Read out of oxlint's JSON report rather than its rendered output: the
 * rendering is a presentation choice that varies with terminal and
 * environment, and a test that parses it reads as a rule regression when it
 * drifts.
 */
const lint = async (source: string): Promise<number[]> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-oxlint-decision-court-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      jsPlugins: [
        path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${RULE_NAME}.ts`),
      ],
      rules: { [RULE_ID]: "error" },
    })};\n`,
  );
  const sourcePath = path.join(directory, "adapter.ts");
  await Bun.write(sourcePath, source);

  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "-f",
      "json",
      sourcePath,
    ],
    { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout] = await Promise.all([
    new Response(spawned.stdout).text(),
    spawned.exited,
  ]);
  const { diagnostics } = JSON.parse(stdout) as {
    diagnostics: readonly Diagnostic[];
  };
  return diagnostics
    .filter(({ code }) => code.startsWith(`${RULE_NAME}(`))
    .map(({ labels }) => labels?.at(0)?.span?.line ?? 0);
};

describe.serial("no-literal-decision-court", () => {
  test("reports every court an adapter states for itself", async () => {
    const source = [
      `const row = { court: "Nejvyšší soud" };`,
      `const asserted = { court: "Ústavní soud" as const };`,
      `const metadata = { metadata: { court: \`RIS \${application}\` } };`,
      `parseDecisionHtml({ caseNumber, court: "Nejvyšší správní soud" });`,
      "",
    ].join("\n");

    // One report per stated court: the row, the asserted literal, the
    // metadata mirror, and the parser argument that carries the same
    // attribution into the stored document.
    expect(await lint(source)).toEqual([1, 2, 3, 4]);
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

    expect(await lint(source)).toEqual([]);
  });
});
