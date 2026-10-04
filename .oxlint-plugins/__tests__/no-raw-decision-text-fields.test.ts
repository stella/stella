import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_METADATA_KEYS,
} from "@stll/api-contract/case-law-text-field";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-raw-decision-text-fields";

setDefaultTimeout(20_000);

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "adapter.ts" });

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
