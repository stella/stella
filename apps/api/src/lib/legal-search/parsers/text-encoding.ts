/**
 * A stored decision's text read through the wrong character set.
 *
 * The class-level guard for every source, in the same place and for the same
 * reason as `markup-residue.ts`: a decoder that assumed the wrong charset, in
 * an adapter or upstream at the publisher, leaves text the reader prints, the
 * index stores and the AI pipeline is prompted with, and none of them can
 * tell. The check needs no reader of the language: `@stll/mojibake` judges
 * the text against the declared language's CLDR letters.
 *
 * Reported, never repaired here. A repair at ingest would hide an adapter
 * that decodes wrongly, and the report names the pair so the adapter can be
 * fixed and the rows re-fetched, or, where the publisher serves the damage
 * itself, transformed back by an operator.
 */

import { panic } from "better-result";

import { checkTextEncoding, type EncodingFinding } from "@stll/mojibake/detect";

/**
 * Log event emitted when a decision's text reads as decoded with the wrong
 * character set. Reported at ERROR and swept per source.
 */
export const TEXT_MISDECODED = "case_law.ingestion.text_misdecoded";

/** Spans a log line carries: enough to see the pattern and find it again. */
const LOGGED_SAMPLES = 3;

export type TextMisdecodedFields = {
  /** Every finding's kind, comma-separated. */
  encodingKinds: string;
  /** `actual>assumed` of the pair that explains the text, when one does. */
  encodingPair?: string;
  encodingLayers?: number;
  encodingConfidence?: number;
  /** Other pairs that explain it as well; a repair then needs the source. */
  encodingAlternatives?: string;
  /** `word@offset→repaired`, or `word@offset` for a signature. */
  encodingSamples: string;
};

const sampleSpans = (finding: EncodingFinding): string[] => {
  switch (finding.kind) {
    case "replacement-character":
    case "c1-control":
      return finding.samples.map(
        ({ text, start }) => `${text}@${String(start)}`,
      );
    case "utf8-read-as-single-byte":
    case "misdecoded":
      return finding.samples.map(
        ({ text, start, repaired }) => `${text}@${String(start)}→${repaired}`,
      );
    default: {
      finding satisfies never;
      return panic(`Unhandled encoding finding: ${String(finding)}`);
    }
  }
};

/**
 * The fields a `TEXT_MISDECODED` line carries for this text, or undefined
 * when the text reads correctly in its declared language.
 */
export const textMisdecodedFields = (
  text: string,
  language: string,
): TextMisdecodedFields | undefined => {
  const check = checkTextEncoding(text, language);
  if (check.status === "clean") {
    return undefined;
  }
  const { findings } = check;
  const misdecoded = findings.find((finding) => finding.kind === "misdecoded");
  const pairFields =
    misdecoded?.kind === "misdecoded"
      ? {
          encodingPair: `${misdecoded.pair.actual}>${misdecoded.pair.assumed}`,
          encodingLayers: misdecoded.layers,
          encodingConfidence: misdecoded.confidence,
          ...(misdecoded.alternatives.length === 0
            ? {}
            : {
                encodingAlternatives: misdecoded.alternatives
                  .map(({ actual, assumed }) => `${actual}>${assumed}`)
                  .join(","),
              }),
        }
      : {};
  return {
    encodingKinds: findings.map(({ kind }) => kind).join(","),
    ...pairFields,
    encodingSamples: findings
      .flatMap(sampleSpans)
      .slice(0, LOGGED_SAMPLES)
      .join("; "),
  };
};
