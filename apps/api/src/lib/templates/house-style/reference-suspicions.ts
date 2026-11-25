// A reference can name a provision that exists and still be wrong: the
// sentence speaks of working conditions and cites the article on force
// majeure, one above the article that is about working conditions. This reads
// the words around an article reference against the article titles and
// reports the mismatch. A hint for a human, never a correction: the reference
// stays linked to what the text says.

import { stripDiacritics } from "@stll/text-normalize";

import type { DocxBlockManifest } from "@/api/lib/templates/house-style/folio-contract";
import type { LabelIndex } from "@/api/lib/templates/house-style/label-index";
import type { DetectedReference } from "@/api/lib/templates/house-style/reference-detector";

type ReferenceSuspicion = {
  referenceId: string;
  designatorIndex: number;
  /** The article the text cites. */
  citedBlockId: string;
  /** The article whose title the surrounding words match. */
  suggestedBlockId: string;
  reason: "topicMismatch";
  /** Low by design: never above 0.5. */
  confidence: number;
};

const STEM_LENGTH = 5;
const WORD_MIN = 4;
/** Title words the sentence must share with another article's title. */
const SHARED_MIN = 3;
/** And the share of that title's distinctive words they must be. */
const SHARED_SHARE_MIN = 0.5;
const TITLE_MAX = 160;
// In hundredths, so the sum stays exact.
const SUSPICION_CONFIDENCE_BASE = 20;
const SUSPICION_CONFIDENCE_STEP = 5;
const SUSPICION_CONFIDENCE_MAX = 50;

/** A crude stem that survives Czech and German inflection: the first
 *  letters of the folded word. */
const stemsOf = (text: string): Set<string> =>
  new Set(
    Array.from(
      stripDiacritics(text)
        .toLowerCase()
        .matchAll(/\p{L}+/gu),
      ([word]) => word,
    )
      .filter((word) => word.length >= WORD_MIN)
      .map((word) => word.slice(0, STEM_LENGTH)),
  );

const SENTENCE_STOPS = [". ", "! ", "? ", ";"] as const;

/** The sentence around `[start, end)`, without the references in it. */
const sentenceAround = (
  text: string,
  { start, end }: { start: number; end: number },
  references: readonly DetectedReference[],
): string => {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const from =
    Math.max(...SENTENCE_STOPS.map((stop) => before.lastIndexOf(stop))) + 1;
  const stops = SENTENCE_STOPS.map((stop) => after.indexOf(stop)).filter(
    (stop) => stop >= 0,
  );
  const to = end + (stops.length > 0 ? Math.min(...stops) : after.length);
  let sentence = "";
  let cursor = from;
  for (const reference of references) {
    if (reference.end <= from || reference.start >= to) {
      continue;
    }
    sentence += text.slice(cursor, Math.max(cursor, reference.start));
    sentence += " ";
    cursor = Math.max(cursor, reference.end);
  }
  return sentence + text.slice(cursor, Math.max(cursor, to));
};

type TopicOptions = {
  manifest: Pick<DocxBlockManifest, "blocks">;
  index: LabelIndex;
  references: readonly DetectedReference[];
};

/**
 * Flags internal article references whose sentence shares its words with a
 * different article's title and none with the cited one.
 */
export const findTopicSuspicions = ({
  manifest,
  index,
  references,
}: TopicOptions): ReferenceSuspicion[] => {
  const titled = index.entries.filter(
    (entry) =>
      entry.level === "article" &&
      entry.annexBlockId === null &&
      entry.title !== "" &&
      entry.title.length <= TITLE_MAX,
  );
  const stemsByArticle = new Map(
    titled.map((entry) => [entry.blockId, stemsOf(entry.title)]),
  );
  const articlesByStem = new Map<string, number>();
  for (const stems of stemsByArticle.values()) {
    for (const stem of stems) {
      articlesByStem.set(stem, (articlesByStem.get(stem) ?? 0) + 1);
    }
  }
  // Only words that single out one article say anything about the topic.
  const distinctive = new Map(
    [...stemsByArticle].map(([blockId, stems]) => [
      blockId,
      [...stems].filter((stem) => articlesByStem.get(stem) === 1),
    ]),
  );
  const textByBlockId = new Map(
    manifest.blocks.map((block) => [block.id, block.text]),
  );
  const referencesByBlockId = Map.groupBy(
    references,
    (reference) => reference.blockId,
  );

  const suspicions: ReferenceSuspicion[] = [];
  for (const reference of references) {
    const text = textByBlockId.get(reference.blockId);
    const inBlock = referencesByBlockId.get(reference.blockId);
    if (
      reference.scope !== "internal" ||
      text === undefined ||
      inBlock === undefined
    ) {
      continue;
    }
    const context = stemsOf(sentenceAround(text, reference, inBlock));
    const shared = (stems: readonly string[]): number =>
      stems.filter((stem) => context.has(stem)).length;
    for (const [
      designatorIndex,
      designator,
    ] of reference.designators.entries()) {
      const { resolution } = designator;
      if (designator.level !== "article" || resolution.status !== "resolved") {
        continue;
      }
      const cited = resolution.targetBlockId;
      const citedStems = distinctive.get(cited);
      // An untitled article gives nothing to compare with.
      if (citedStems === undefined || shared(citedStems) > 0) {
        continue;
      }
      let best: { blockId: string; count: number } | null = null;
      for (const [blockId, stems] of distinctive) {
        const count = shared(stems);
        if (
          blockId !== cited &&
          count >= SHARED_MIN &&
          count >= stems.length * SHARED_SHARE_MIN &&
          count > (best?.count ?? 0)
        ) {
          best = { blockId, count };
        }
      }
      if (best !== null) {
        suspicions.push({
          referenceId: reference.id,
          designatorIndex,
          citedBlockId: cited,
          suggestedBlockId: best.blockId,
          reason: "topicMismatch",
          confidence:
            Math.min(
              SUSPICION_CONFIDENCE_MAX,
              SUSPICION_CONFIDENCE_BASE +
                SUSPICION_CONFIDENCE_STEP * best.count,
            ) / 100,
        });
      }
    }
  }
  return suspicions;
};
