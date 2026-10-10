import { panic, Result } from "better-result";

import { createPipelineContext } from "@stll/anonymize";
import type { GazetteerEntry } from "@stll/anonymize";

import { toSafeId } from "@/api/lib/branded-types";
import {
  FORCED_VALUE_CASES,
  FORCED_VALUE_IDS,
  NAME_MATCHING_CASES,
  NAME_MATCHING_ENTRIES,
} from "@/api/mcp/__fixtures__/name-matching-corpus";
import type { NameMatchingCase } from "@/api/mcp/__fixtures__/name-matching-corpus";
import { anonymizeTextFields } from "@/api/mcp/anonymization";

/**
 * Runs the labeled name-matching corpus through `anonymizeTextFields`, the
 * production entry point with its field join and strict split, and tallies
 * each class.
 *
 * Every case runs twice on the same fields: once with the matcher under test
 * active and once as a control without it, so a hit can be attributed to the
 * matcher rather than to another recognizer.
 *
 * Matchers:
 * - `deny-list`: the corpus entries as the workspace deny-list.
 * - `forced`: the chat boundary's forced identifiers. The cases sit in a
 *   second field after a sibling field that carries the identifiers, so the
 *   forced values are active for every case.
 */

export const NAME_MATCHING_MATCHERS = ["deny-list", "forced"] as const;

type NameMatchingMatcher = (typeof NAME_MATCHING_MATCHERS)[number];

export type NameMatchingTally = {
  expectation: NameMatchingCase["expectation"];
  total: number;
  /** Cases whose label held with the matcher active. */
  held: number;
  /** Cases whose label held in the control run, without the matcher. */
  heldByControl: number;
  /** Redact cases the matcher redacts and the control does not. */
  attributed: number;
  /** Keep cases the matcher redacts and the control leaves intact. */
  attributedFalsePositives: number;
  /** Cases whose output could not be split back into fields. */
  splitFailures: number;
  failures: { surface: string; output: string | null }[];
};

export type NameMatchingReport = Record<
  NameMatchingMatcher,
  Record<string, NameMatchingTally>
>;

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

/** The case's own field after anonymization, or null when the split failed. */
const anonymizeCaseField = async ({
  context,
  fields,
  forcedSensitiveValues,
  gazetteerEntries,
}: {
  context: ReturnType<typeof createPipelineContext>;
  fields: string[];
  forcedSensitiveValues: readonly string[];
  gazetteerEntries: GazetteerEntry[];
}): Promise<string | null> => {
  const result = await anonymizeTextFields({
    catalogs: { type: "preloaded", excludedCanonicals: [], gazetteerEntries },
    context,
    fields,
    forcedSensitiveValues,
    organizationId: toSafeId<"organization">("org_name_matching_corpus"),
    workspaceId: "name-matching-corpus",
  });
  if (Result.isError(result)) {
    return null;
  }
  return result.value.fields.at(-1) ?? null;
};

const measureMatcher = async (
  matcher: NameMatchingMatcher,
): Promise<Record<string, NameMatchingTally>> => {
  const cases =
    matcher === "forced"
      ? [
          ...FORCED_VALUE_CASES,
          ...NAME_MATCHING_CASES.filter((item) => item.expectation === "keep"),
        ]
      : NAME_MATCHING_CASES;
  const treatmentContext = createPipelineContext();
  const controlContext = createPipelineContext();
  const tallies: Record<string, NameMatchingTally> = {};

  for (const testCase of cases) {
    const fields =
      matcher === "forced"
        ? [FORCED_CONTEXT_FIELD, testCase.text]
        : [testCase.text];
    const output = await anonymizeCaseField({
      context: treatmentContext,
      fields,
      forcedSensitiveValues: matcher === "forced" ? forcedSurfaces(fields) : [],
      gazetteerEntries:
        matcher === "deny-list" ? [...NAME_MATCHING_ENTRIES] : [],
    });
    const controlOutput = await anonymizeCaseField({
      context: controlContext,
      fields,
      forcedSensitiveValues: [],
      gazetteerEntries: [],
    });

    const tally = tallies[testCase.kind] ?? {
      expectation: testCase.expectation,
      total: 0,
      held: 0,
      heldByControl: 0,
      attributed: 0,
      attributedFalsePositives: 0,
      splitFailures: 0,
      failures: [],
    };
    tallies[testCase.kind] = tally;

    const held = output !== null && nameMatchingCaseHeld(testCase, output);
    const heldByControl =
      controlOutput !== null && nameMatchingCaseHeld(testCase, controlOutput);
    tally.total += 1;
    if (output === null || controlOutput === null) {
      tally.splitFailures += 1;
    }
    if (held) {
      tally.held += 1;
    } else {
      tally.failures.push({ surface: testCase.surface, output });
    }
    if (heldByControl) {
      tally.heldByControl += 1;
    }
    if (testCase.expectation === "redact" && held && !heldByControl) {
      tally.attributed += 1;
    }
    if (testCase.expectation === "keep" && !held && heldByControl) {
      tally.attributedFalsePositives += 1;
    }
  }

  return tallies;
};

export const measureNameMatchingCorpus =
  async (): Promise<NameMatchingReport> => ({
    "deny-list": await measureMatcher("deny-list"),
    forced: await measureMatcher("forced"),
  });
