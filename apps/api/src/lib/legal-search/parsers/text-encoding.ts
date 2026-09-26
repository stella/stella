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

import { MARKUP_RESIDUE_EXCERPT_CHARS } from "@/api/lib/legal-search/parsers/markup-residue";

/**
 * Log event emitted when a decision's text reads as decoded with the wrong
 * character set. Reported at ERROR and swept per source.
 */
export const TEXT_MISDECODED = "case_law.ingestion.text_misdecoded";

/** Spans a log line carries: enough to see the pattern and find it again. */
const LOGGED_SAMPLES = 3;

/**
 * Characters of one span, or of its repair, a log line carries: the bound
 * the markup-residue report keeps. A word is split on whitespace only, so
 * space-free text is one word the length of the document.
 */
const EXCERPT_CHARS = MARKUP_RESIDUE_EXCERPT_CHARS;

/** The whole `encodingSamples` field, marker included. */
export const ENCODING_SAMPLES_MAX_CHARS = LOGGED_SAMPLES * 3 * EXCERPT_CHARS;

const LAST_BMP_CODE_POINT = 0xff_ff;

/** Longest `…[+N]` marker: N is a string length, at most 2^53 - 1. */
const TRUNCATION_MARKER_MAX_CHARS = "…[+]".length + 16;

/**
 * `text` cut to `keep` characters, followed by `…[+N]` naming how many were
 * left out; unchanged when it fits. A surrogate pair is never split.
 */
const truncated = (text: string, keep: number): string => {
  if (text.length <= keep) {
    return text;
  }
  // A code point above the BMP starting at the last kept unit is a pair the
  // cut would split.
  const end =
    (text.codePointAt(keep - 1) ?? 0) > LAST_BMP_CODE_POINT ? keep - 1 : keep;
  return `${text.slice(0, end)}…[+${String(text.length - end)}]`;
};

const excerpt = (text: string): string => truncated(text, EXCERPT_CHARS);

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
        ({ text, start }) => `${excerpt(text)}@${String(start)}`,
      );
    case "utf8-read-as-single-byte":
    case "misdecoded":
      return finding.samples.map(
        ({ text, start, repaired }) =>
          `${excerpt(text)}@${String(start)}→${excerpt(repaired)}`,
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
    encodingSamples: truncated(
      findings.flatMap(sampleSpans).slice(0, LOGGED_SAMPLES).join("; "),
      ENCODING_SAMPLES_MAX_CHARS - TRUNCATION_MARKER_MAX_CHARS,
    ),
  };
};
