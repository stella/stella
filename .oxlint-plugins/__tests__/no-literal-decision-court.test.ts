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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/**
 * The line one diagnostic of this rule reports, or null for any other
 * diagnostic. Narrowed rather than asserted: the report is another process's
 * output, so its shape is a claim to check, not one to assume.
 */
const reportedLine = (diagnostic: unknown): number | null => {
  if (!isRecord(diagnostic) || typeof diagnostic.code !== "string") {
    return null;
  }
  if (!diagnostic.code.startsWith(`${RULE_NAME}(`)) {
    return null;
  }
  const label = isUnknownArray(diagnostic.labels)
    ? diagnostic.labels.at(0)
    : undefined;
  const span = isRecord(label) ? label.span : undefined;
  const line = isRecord(span) ? span.line : undefined;
  return typeof line === "number" ? line : null;
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
  const report: unknown = JSON.parse(stdout);
  const diagnostics = isRecord(report) ? report.diagnostics : undefined;
  if (!isUnknownArray(diagnostics)) {
    throw new Error(`oxlint reported no diagnostics array: ${stdout}`);
  }
  return diagnostics
    .map(reportedLine)
    .filter((line): line is number => line !== null);
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
