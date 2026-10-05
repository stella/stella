import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { ProvisionPlacementFailure } from "@stll/api-contract/provision-placement";
import { caseLawSectionHeading } from "@stll/legal-ast/case-law-heading";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import type {
  Block,
  DocumentAst,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";
import {
  fulltextProjectionPieces,
  projectionPieces,
} from "@stll/legal-ast/projection-digest";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";
import { dropOverlappingSpans } from "@stll/legal-ast/text-spans";
import { escapeRegExp } from "@stll/text-normalize";

import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";

/**
 * A provision reference to locate: the sentence the extractor read it from
 * and the reference itself. `id` keys the rendered anchor.
 */
export type ProvisionAnchorSource<T = unknown> = {
  /** Exact rendered span when a local parser located this occurrence. */
  exactSpan?: { blockId: string; end: number; start: number } | undefined;
  id: string;
  jurisdiction?: CaseLawJurisdiction;
  workEli?: string | null;
  reference: Pick<
    ProvisionReference,
    "letter" | "section" | "sectionSuffix" | "subsection" | "unit"
  >;
  sentenceText: string;
  /** Global source offset; distinguishes repeated references in one sentence. */
  spanStart: number;
  /** Computed from every stored row, including unresolved targets. */
  occurrence?: { ordinal: number; count: number } | undefined;
  target: T;
};

export type ProvisionAnchorSpan<T = unknown> = {
  end: number;
  source: ProvisionAnchorSource<T>;
  start: number;
};

/**
 * The stored sentence has no reliable offsets into rendered text. Match its
 * complete context with publisher whitespace differences before locating the
 * reference; an eight-word prefix cannot distinguish repeated openings.
 */
const sentencePattern = (sentenceText: string): RegExp | null => {
  const tokens = sentenceText.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  // A period may or may not be followed by a space in either text
  // ("1.Žalobce" against "1. Žalobce"), so it tolerates one.
  const source = tokens
    .map((token) => escapeRegExp(token).replaceAll("\\.", "\\.\\s*"))
    .join("\\s*");
  return new RegExp(source, "u");
};

/**
 * The reference as the decision prints it: the sign or the article word, the
 * number with its inserted-provision letter, then each named
 * subdivision the stored reference carries. `§ 90` also
 * matches "§ 90 odst. 5" when the row states no subsection; a row that does
 * state one extends the match over it when the text agrees.
 *
 * The subdivision word is abbreviated in most judgments and spelled out in
 * some ("§ 273 odstavec 1 tr. zákoníku"), which is the same reference; the
 * Czech and Slovak inflections of the spelled-out word follow the stem.
 */
const referencePattern = ({
  letter,
  section,
  sectionSuffix,
  subsection,
  unit,
}: ProvisionAnchorSource["reference"]): RegExp => {
  const head =
    unit === "article" ? String.raw`(?:čl\.|článk\p{Ll}*|art\.|Art\.)` : "§";
  const number = `${String(section)}${sectionSuffix === null ? "" : escapeRegExp(sectionSuffix)}`;
  const parts = [String.raw`${head}\s*${number}(?![\p{N}\p{L}])`];
  if (subsection !== null) {
    parts.push(
      String.raw`(?:\s*(?:odst\.|odstav\p{Ll}*|odsek\p{Ll}*|ods\.|ust\.|para\.)\s*${escapeRegExp(subsection)}(?![\p{N}\p{L}]))`,
    );
  }
  if (letter !== null) {
    parts.push(
      String.raw`(?:\s*(?:písm\.|písmeno|lit\.)\s*${escapeRegExp(letter)}\)?)`,
    );
  }
  return new RegExp(parts.join(""), "u");
};

type OccurrenceSource = Pick<
  ProvisionAnchorSource,
  "id" | "reference" | "sentenceText" | "spanStart" | "workEli"
>;

/** Count every stored occurrence before unavailable targets are filtered. */
export const provisionOccurrenceContexts = (
  provisions: readonly OccurrenceSource[],
) => {
  const groups = new Map<string, OccurrenceSource[]>();
  for (const source of [...provisions].toSorted(
    (left, right) => left.spanStart - right.spanStart,
  )) {
    const key = JSON.stringify([
      source.sentenceText,
      source.workEli,
      referencePattern(source.reference).source,
    ]);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [source]);
    } else {
      group.push(source);
    }
  }
  const contexts = new Map<string, { ordinal: number; count: number }>();
  for (const group of groups.values()) {
    const offsets = [...new Set(group.map(({ spanStart }) => spanStart))];
    for (const source of group) {
      contexts.set(source.id, {
        ordinal: offsets.indexOf(source.spanStart),
        count: offsets.length,
      });
    }
  }
  return contexts;
};

type ProvisionAnchorPlacements<T> = {
  anchorsByPieceId: Record<string, ProvisionAnchorSpan<T>[]>;
  failures: ProvisionPlacementFailure[];
};

/** Exact sentence context may cross pieces; competing occurrences remain explicit. */
export const locateProvisionAnchors = <T>({
  blocks,
  provisions,
}: {
  blocks: readonly Block[];
  provisions: readonly ProvisionAnchorSource<T>[];
}): ProvisionAnchorPlacements<T> => {
  const pieces = projectionPieces({ blocks: [...blocks] });
  const texts: { pieceId: string; text: string; start: number; end: number }[] =
    [];
  let offset = 0;
  for (const { pieceId, text } of pieces) {
    texts.push({ pieceId, text, start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  const joined = texts.map(({ text }) => text).join("\n");
  const failures: ProvisionPlacementFailure[] = [];
  const hitsByPiece = new Map<string, ProvisionAnchorSpan<T>[]>();
  const contexts = provisionOccurrenceContexts(provisions);
  for (const source of provisions) {
    let pieceId: string;
    let start: number;
    let end: number;
    if (source.exactSpan !== undefined) {
      const piece = texts.find(
        (candidate) => candidate.pieceId === source.exactSpan?.blockId,
      );
      if (
        piece === undefined ||
        source.exactSpan.start < 0 ||
        source.exactSpan.end <= source.exactSpan.start ||
        source.exactSpan.end > piece.text.length
      ) {
        failures.push({ id: source.id, reason: "span-out-of-bounds" });
        continue;
      }
      pieceId = piece.pieceId;
      start = source.exactSpan.start;
      end = source.exactSpan.end;
    } else {
      const pattern = sentencePattern(source.sentenceText);
      if (pattern === null) {
        failures.push({ id: source.id, reason: "sentence-unlocatable" });
        continue;
      }
      const sentences = [...joined.matchAll(new RegExp(pattern.source, "gu"))];
      const sentence = sentences.at(0);
      if (sentence === undefined) {
        failures.push({ id: source.id, reason: "sentence-unlocatable" });
        continue;
      }
      if (sentences.length > 1) {
        failures.push({ id: source.id, reason: "ambiguous-placement" });
        continue;
      }
      const reference = referencePattern(source.reference);
      const grammar =
        source.jurisdiction === undefined
          ? undefined
          : PROVISION_CITATION_GRAMMARS[source.jurisdiction];
      const printed =
        grammar?.status === "supported"
          ? grammar
              .locateAbbreviatedProvisions(sentence[0])
              .filter(
                (citation) =>
                  citation.reference.unit === source.reference.unit &&
                  citation.reference.section === source.reference.section &&
                  citation.reference.sectionSuffix ===
                    source.reference.sectionSuffix &&
                  citation.reference.subsection ===
                    source.reference.subsection &&
                  citation.reference.letter === source.reference.letter,
              )
          : [];
      const occurrences =
        printed.length > 0
          ? printed
              .filter(({ abbreviation }) => abbreviation.eli === source.workEli)
              .map(({ start: occurrenceStart, end: occurrenceEnd }) => ({
                index: occurrenceStart,
                text: sentence[0].slice(occurrenceStart, occurrenceEnd),
              }))
          : [...sentence[0].matchAll(new RegExp(reference.source, "gu"))].map(
              (match) => ({ index: match.index, text: match[0] }),
            );
      const occurrence = source.occurrence ?? contexts.get(source.id);
      if (occurrences.length === 0) {
        failures.push({ id: source.id, reason: "reference-unlocatable" });
        continue;
      }
      if (occurrence === undefined || occurrences.length !== occurrence.count) {
        failures.push({ id: source.id, reason: "ambiguous-placement" });
        continue;
      }
      const match = occurrences.at(occurrence.ordinal);
      if (match === undefined) {
        failures.push({ id: source.id, reason: "ambiguous-placement" });
        continue;
      }
      const globalStart = sentence.index + match.index;
      const globalEnd = globalStart + match.text.length;
      const piece = texts.find(
        (candidate) =>
          candidate.start <= globalStart && globalEnd <= candidate.end,
      );
      if (piece === undefined) {
        failures.push({ id: source.id, reason: "span-out-of-bounds" });
        continue;
      }
      pieceId = piece.pieceId;
      start = globalStart - piece.start;
      end = globalEnd - piece.start;
    }
    const span = { end, source, start };
    const hits = hitsByPiece.get(pieceId);
    if (hits === undefined) {
      hitsByPiece.set(pieceId, [span]);
    } else {
      hits.push(span);
    }
  }
  const anchoredPieces = new Map<string, ProvisionAnchorSpan<T>[]>();
  for (const [pieceId, spans] of hitsByPiece) {
    const kept = dropOverlappingSpans(spans);
    const keptSources = new Set(kept.map(({ source }) => source));
    for (const { source } of spans) {
      if (!keptSources.has(source)) {
        failures.push({ id: source.id, reason: "span-overlap" });
      }
    }
    anchoredPieces.set(pieceId, kept);
  }
  return { anchorsByPieceId: Object.fromEntries(anchoredPieces), failures };
};

/**
 * Remove structural metadata that the reader renders elsewhere. Content is
 * never hidden by matching its words: a court's title and constitutional
 * formula are part of the decision and remain visible as AST headings. The
 * case-number header is the reference line only for a docket primary; under
 * any other primary it is the docket, which nothing else shows, so it stays.
 */
export const decisionTextBlocks = (
  ast: DocumentAst | null,
  caseNumberType: DecisionPrimaryReferenceType,
  fulltext?: string | null,
): Block[] => {
  const docketIsReferenceLine =
    caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
  const visible: Block[] = [];
  let inReasoning = false;
  for (const block of ast === null ? [] : ast.blocks) {
    if (
      (docketIsReferenceLine &&
        block.type === "paragraph" &&
        block.role === "case-number") ||
      (block.type === "table" && block.role === "related-proceedings")
    ) {
      continue;
    }
    if (
      block.type === "heading" &&
      /^Odůvodnění\s*:?$/iu.test(block.plainText)
    ) {
      inReasoning = true;
    }
    if (inReasoning && block.type === "paragraph" && block.role === undefined) {
      const heading = caseLawSectionHeading(block.plainText);
      if (heading !== null) {
        visible.push({
          anchorId: block.anchorId,
          id: block.id,
          inlines: block.inlines,
          level: heading.level,
          plainText: block.plainText,
          type: "heading",
        });
        continue;
      }
    }
    visible.push(block);
  }
  if (visible.length > 0 || !fulltext) {
    return visible;
  }
  return fulltextProjectionPieces(fulltext).map(
    ({ pieceId, text }): ParagraphBlock => ({
      id: pieceId,
      anchorId: pieceId,
      type: "paragraph",
      plainText: text,
      inlines: [{ type: "text", text }],
    }),
  );
};
