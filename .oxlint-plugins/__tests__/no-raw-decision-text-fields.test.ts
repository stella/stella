import { panic, Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_METADATA_KEYS,
} from "@stll/api-contract/case-law-text-field";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const RULE_NAME = "no-raw-decision-text-fields";
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

const lint = async (source: string): Promise<number[]> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-oxlint-decision-text-fields-"),
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
  const [stdout, stderr] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (Result.isError(report)) {
    return panic(`oxlint did not produce valid JSON:\n${output}`);
  }
  const diagnostics = isRecord(report.value)
    ? report.value.diagnostics
    : undefined;
  if (!isUnknownArray(diagnostics)) {
    return panic(`oxlint reported no diagnostics array:\n${output}`);
  }
  return diagnostics
    .map(reportedLine)
    .filter((line): line is number => line !== null);
};

describe.serial("no-raw-decision-text-fields", () => {
  test("rejects every decision text field written into metadata", async () => {
    const source = DECISION_TEXT_METADATA_KEYS.map(
      (key) =>
        `const ${key}Row = { metadata: { ${key}: raw }, textFields: validTextFields };`,
    ).join("\n");

    expect(await lint(source)).toEqual(
      DECISION_TEXT_METADATA_KEYS.map((_key, index) => index + 1),
    );
  });

  test("rejects protected fields written directly into metadata", async () => {
    const source = [
      "const direct = { metadata: { abstract: raw }, textFields: validTextFields };",
      'const computed = { metadata: { ["headnote"]: parsed }, textFields: validTextFields };',
      "decision.metadata.legalSentence = parsed;",
      'decision.metadata["summary"] = raw;',
      `decision.metadata.${DECISION_TEXT_ABSENCE_METADATA_KEY} = forged;`,
      "decision.metadata = { abstract: parsed };",
      'decision["metadata"] = { summary: parsed };',
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("requires aliased and dynamic metadata to cross the checked boundary", async () => {
    const source = [
      "const alias = { metadata: rawMetadata, textFields: validTextFields };",
      "const spread = { metadata: { ...rawMetadata }, textFields: validTextFields };",
      "const computed = { metadata: { [dynamicKey]: raw }, textFields: validTextFields };",
      "decision.metadata = rawMetadata;",
      "decision.metadata[dynamicKey] = raw;",
      "Object.assign(decision.metadata, { sourceId });",
      "decision.textFields[dynamicKey] = parsedTextField;",
      "Object.assign(decision.textFields, { summary: parsedTextField });",
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("rejects obvious raw literals written into textFields", async () => {
    const rawInterpolation = `${String.fromCodePoint(36)}{suffix}`;
    const source = [
      'const direct = { textFields: { abstract: "raw" } };',
      `const template = { textFields: { headnote: \`raw ${rawInterpolation}\` } };`,
      'decision.textFields.legalSentence = "raw" as const;',
      `decision.textFields!["summary"] = \`raw ${rawInterpolation}\`;`,
      'decision.textFields = { ["abstract"]: "raw" };',
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5]);
  });

  test("allows source fields and TextField-valued expressions", async () => {
    const source = [
      'const source = { summary: "raw publisher value" };',
      "const row = {",
      "  metadata: { sourceId },",
      "  textFields: {",
      "    abstract: sourceTextField(adapterKey, source.abstract),",
      "    headnote: presentTextField(source.headnote),",
      "    legalSentence: absentTextField(reason),",
      "    summary: parsedTextField,",
      "  },",
      "};",
      "decision.textFields.summary = parsedTextField;",
      "const previous = decision.metadata.summary;",
      "const checked = { metadata: checkedDecisionMetadata(rawMetadata), textFields: validTextFields };",
      "const unrelated = { metadata: rawMetadata };",
      "decision.metadata = { sourceId };",
      "const { metadata } = decision;",
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
