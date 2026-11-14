/**
 * Read-only offline review:
 * bun apps/api/scripts/citation-kind-suspects.ts [citations.jsonl]
 * Each row supplies id, country, citationText, context, and sentence (nullable).
 * Supply the actual citing sentence, preserving legal abbreviations; context
 * is the ingestion window. Output includes every suspect, ranked CZ/SK first.
 */
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import {
  CITATION_KIND,
  citationKindSignals,
  classifyWithoutPublisher,
} from "../src/handlers/case-law/citation-kind";

// Exports may carry additional provenance; output is limited to this contract.
const reviewCitationSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  country: v.pipe(v.string(), v.nonEmpty()),
  citationText: v.pipe(v.string(), v.nonEmpty()),
  context: v.nullable(v.string()),
  sentence: v.nullable(v.string()),
});

type ReviewCitation = v.InferOutput<typeof reviewCitationSchema>;

const REASON_WEIGHTS = {
  "cue-registry-conflict": 3,
  "cue-outside-sentence": 2,
  "unlisted-registry": 1,
} as const;

type SuspectReason = keyof typeof REASON_WEIGHTS;

export const rankCitationKindSuspects = (
  citations: readonly ReviewCitation[],
) => {
  const suspects = [];
  for (const citation of citations) {
    const window = citationKindSignals(citation);
    const sentence = citationKindSignals({
      citationText: citation.citationText,
      context: citation.sentence,
    });
    const reasons: SuspectReason[] = [];
    const verdict = classifyWithoutPublisher(citation);
    const cueKind = window.procedural
      ? CITATION_KIND.PROCEDURAL
      : CITATION_KIND.PRECEDENT;
    if (
      window.procedural !== window.precedent &&
      cueKind !== window.registryKind
    ) {
      reasons.push("cue-registry-conflict");
    }
    if (
      citation.sentence !== null &&
      ((window.procedural && !sentence.procedural) ||
        (window.precedent && !sentence.precedent))
    ) {
      reasons.push("cue-outside-sentence");
    }
    // This is an unlisted authority prior, not proof that a court is unknown
    // or that the reference is wrong: lower-instance registries also land here.
    if (window.registryKind === CITATION_KIND.PROCEDURAL) {
      reasons.push("unlisted-registry");
    }
    if (reasons.length === 0) {
      continue;
    }
    suspects.push({
      ...citation,
      reasons,
      score: reasons.reduce(
        (total, reason) => total + REASON_WEIGHTS[reason],
        0,
      ),
      verdict,
      registryKind: window.registryKind,
    });
  }
  const priority = (country: string) =>
    country === "CZ" || country === "SK" ? 0 : 1;
  return suspects.toSorted(
    (left, right) =>
      priority(left.country) - priority(right.country) ||
      right.score - left.score ||
      compareCodeUnit(left.id, right.id) ||
      compareCodeUnit(left.citationText, right.citationText),
  );
};

export const parseReviewCitations = (jsonl: string) =>
  jsonl
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => v.parse(reviewCitationSchema, JSON.parse(line)));

if (import.meta.main) {
  const inputPath = Bun.argv.at(2);
  const citations = parseReviewCitations(
    await (inputPath === undefined ? Bun.stdin : Bun.file(inputPath)).text(),
  );
  for (const suspect of rankCitationKindSuspects(citations)) {
    console.log(JSON.stringify(suspect));
  }
}
