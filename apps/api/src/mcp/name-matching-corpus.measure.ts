import { panic } from "better-result";

import {
  createNativePipelineFromConfig,
  createPipelineContext,
  deanonymise,
  loadNativeAnonymizeBinding,
} from "@stll/anonymize";
import type { GazetteerEntry } from "@stll/anonymize";
import { runChatAnonPipeline } from "@stll/anonymize-chat";
import { loadNameDictionaries } from "@stll/anonymize-data";

import {
  FORCED_VALUE_CASES,
  FORCED_VALUE_IDS,
  NAME_MATCHING_CASES,
  NAME_MATCHING_ENTRIES,
} from "@/api/mcp/__fixtures__/name-matching-corpus";
import type { NameMatchingCase } from "@/api/mcp/__fixtures__/name-matching-corpus";

/**
 * Runs the labeled name-matching corpus through `runChatAnonPipeline` with
 * the production native runtime and name dictionaries, the call the chat
 * boundary makes, and tallies each class.
 *
 * Modes:
 * - `deny-list`: the corpus entries as the workspace deny-list.
 * - `deny-list-control`: same texts, empty deny-list, to attribute outcomes.
 * - `forced`: the chat boundary's forced identifiers, present in a sibling
 *   field so they are active for every case.
 * - `forced-control`: same texts and fields, no forced identifiers.
 */

export type NameMatchingMode =
  | "deny-list"
  | "deny-list-control"
  | "forced"
  | "forced-control";

export type NameMatchingTally = {
  expectation: NameMatchingCase["expectation"];
  /** Cases whose label held: redacted for `redact`, intact for `keep`. */
  passed: number;
  total: number;
  failures: { surface: string; output: string }[];
};

export type NameMatchingReport = Partial<
  Record<NameMatchingMode, Record<string, NameMatchingTally>>
>;

export const NAME_MATCHING_MODES = [
  "deny-list",
  "deny-list-control",
  "forced",
  "forced-control",
] as const satisfies readonly NameMatchingMode[];

/** Legal-form tokens: leaving them visible does not identify the party. */
const NON_IDENTIFYING_TOKENS = new Set(["spol", "ltd", "limited"]);

const escapeRegExp = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, (match) => `\\${match}`);

const identifyingTokens = (surface: string): string[] =>
  surface
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(
      (token) =>
        token.length >= 3 && !NON_IDENTIFYING_TOKENS.has(token.toLowerCase()),
    );

const containsWord = (text: string, word: string) =>
  new RegExp(
    String.raw`(?<![\p{L}\p{M}\p{N}])${escapeRegExp(word)}(?![\p{L}\p{M}\p{N}])`,
    "u",
  ).test(text);

/** Whether a case's label held for one redacted output. */
export const nameMatchingCaseHeld = (
  testCase: NameMatchingCase,
  output: string,
): boolean => {
  switch (testCase.expectation) {
    case "redact": {
      return identifyingTokens(testCase.surface).every(
        (token) => !containsWord(output, token),
      );
    }
    case "keep": {
      return output.includes(testCase.surface);
    }
    default: {
      testCase satisfies never;
      return panic("Unhandled name-matching expectation");
    }
  }
};

/**
 * Mirrors how the chat boundary widens its forced identifiers: every
 * case-insensitive occurrence in a field becomes a forced surface too.
 */
const forcedSurfaces = (fields: readonly string[]): string[] => {
  const surfaces = new Set<string>(FORCED_VALUE_IDS);
  for (const field of fields) {
    const lowered = field.toLowerCase();
    for (const value of FORCED_VALUE_IDS) {
      let offset = lowered.indexOf(value);
      while (offset !== -1) {
        surfaces.add(field.slice(offset, offset + value.length));
        offset = lowered.indexOf(value, offset + value.length);
      }
    }
  }
  return [...surfaces];
};

const FORCED_CONTEXT_FIELD = `Organization ${FORCED_VALUE_IDS[0]}, scope ${FORCED_VALUE_IDS[1]}.`;
const FIELD_SEPARATOR = "\n\n";
const WORKSPACE_ID = "name-matching-corpus";

const runtime = {
  getBinding: loadNativeAnonymizeBinding,
  createNativePipelineFromConfig,
  createPipelineContext,
  deanonymise,
};

let dictionariesPromise: ReturnType<typeof loadNameDictionaries> | null = null;

const redactCaseText = async ({
  context,
  fields,
  forcedSensitiveValues,
  gazetteerEntries,
}: {
  context: ReturnType<typeof createPipelineContext>;
  fields: readonly string[];
  forcedSensitiveValues: readonly string[];
  gazetteerEntries: GazetteerEntry[];
}): Promise<string> => {
  dictionariesPromise ??= loadNameDictionaries();
  const result = await runChatAnonPipeline({
    context,
    dictionaries: await dictionariesPromise,
    excludedCanonicals: [],
    forcedSensitiveValues,
    gazetteerEntries,
    runtime,
    text: fields.join(FIELD_SEPARATOR),
    workspaceId: WORKSPACE_ID,
  });
  const lastSeparator = result.redactedText.lastIndexOf(FIELD_SEPARATOR);
  return fields.length === 1 || lastSeparator === -1
    ? result.redactedText
    : result.redactedText.slice(lastSeparator + FIELD_SEPARATOR.length);
};

const runMode = async (
  mode: NameMatchingMode,
): Promise<Record<string, NameMatchingTally>> => {
  const forcedMode = mode === "forced" || mode === "forced-control";
  const cases = forcedMode
    ? [
        ...FORCED_VALUE_CASES,
        ...NAME_MATCHING_CASES.filter((item) => item.expectation === "keep"),
      ]
    : NAME_MATCHING_CASES;
  const gazetteerEntries: GazetteerEntry[] =
    mode === "deny-list" ? [...NAME_MATCHING_ENTRIES] : [];
  const context = createPipelineContext();
  const tallies: Record<string, NameMatchingTally> = {};

  for (const testCase of cases) {
    const fields = forcedMode
      ? [FORCED_CONTEXT_FIELD, testCase.text]
      : [testCase.text];
    const forcedSensitiveValues =
      mode === "forced" ? forcedSurfaces(fields) : [];
    const output = await redactCaseText({
      context,
      fields,
      forcedSensitiveValues,
      gazetteerEntries,
    });
    const tally = tallies[testCase.kind] ?? {
      expectation: testCase.expectation,
      passed: 0,
      total: 0,
      failures: [],
    };
    tallies[testCase.kind] = tally;
    tally.total += 1;
    if (nameMatchingCaseHeld(testCase, output)) {
      tally.passed += 1;
    } else {
      tally.failures.push({ surface: testCase.surface, output });
    }
  }

  return tallies;
};

export const measureNameMatchingCorpus = async ({
  modes = NAME_MATCHING_MODES,
}: {
  modes?: readonly NameMatchingMode[];
} = {}): Promise<NameMatchingReport> => {
  const report: NameMatchingReport = {};
  for (const mode of modes) {
    report[mode] = await runMode(mode);
  }
  return report;
};
