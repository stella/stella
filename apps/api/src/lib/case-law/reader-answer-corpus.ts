import { panic, Result, TaggedError } from "better-result";

import { plainTextOf } from "@stll/legal-ast/document-ast";

import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  listIncomingDecisionCitations,
  listOutgoingDecisionCitations,
} from "@/api/lib/case-law/decision-citations";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";

export const READER_ANSWER_RELATED_LIMITS = {
  decisions: 8,
  paragraphs: 6,
  excerptChars: 1600,
  queryChars: 2000,
} as const;

export class ReaderAnswerCorpusError extends TaggedError(
  "ReaderAnswerCorpusError",
)<{ message: string; cause: unknown }> {}

export type ReaderAnswerParagraph = { paragraphId: string; text: string };
export type ReaderAnswerDecision = {
  decisionId: SafeId<"caseLawDecision">;
  paragraphs: ReaderAnswerParagraph[];
};
export type ReaderAnswerRelatedDirection = "cited" | "citing" | "both";
export type ReaderAnswerRelatedExcerpt = ReaderAnswerParagraph & {
  decisionId: SafeId<"caseLawDecision">;
};

const readRelatedDecisionIds = async (
  decisionId: SafeId<"caseLawDecision">,
  direction: ReaderAnswerRelatedDirection,
  caseLawDb = caseLawPublicReadDb,
) =>
  await withRedistributableSubject(
    caseLawDb,
    { kind: "id", id: decisionId },
    async ({ tx, id }) => {
      const [outgoing, incoming] = await Promise.all([
        direction === "citing"
          ? null
          : listOutgoingDecisionCitations({
              tx,
              decisionId: id,
              cursor: undefined,
            }),
        direction === "cited"
          ? null
          : listIncomingDecisionCitations({
              tx,
              decisionId: id,
              cursor: undefined,
            }),
      ]);
      if (outgoing !== null && !("items" in outgoing)) {
        return panic(
          "A cursor-free outgoing citation read rejected its cursor",
        );
      }
      if (incoming !== null && !("items" in incoming)) {
        return panic(
          "A cursor-free incoming citation read rejected its cursor",
        );
      }
      // Interleave both directions so an outgoing page cannot crowd out citing decisions.
      const ids = new Set<SafeId<"caseLawDecision">>();
      const outgoingIds =
        outgoing?.items.flatMap((row) =>
          row.citedDecisionId === null ? [] : [row.citedDecisionId],
        ) ?? [];
      const incomingIds =
        incoming?.items.map((row) => row.citingDecisionId) ?? [];
      for (
        let index = 0;
        index < Math.max(outgoingIds.length, incomingIds.length);
        index++
      ) {
        for (const candidate of [
          outgoingIds.at(index),
          incomingIds.at(index),
        ]) {
          if (candidate !== undefined && candidate !== id) {
            ids.add(candidate);
          }
          if (ids.size === READER_ANSWER_RELATED_LIMITS.decisions) {
            return [...ids];
          }
        }
      }
      return [...ids];
    },
  );

export type ReaderAnswerCorpusDependencies = {
  caseLawDb?: CaseLawPublicReadDb;
  readDecision?: typeof readDecisionReaderSource;
  readRelatedIds?: typeof readRelatedDecisionIds;
};

/** The ordinary model reader applies publication, tombstones and derived-AI admission. */
export const readReaderAnswerDecision = async (
  decisionId: SafeId<"caseLawDecision">,
  {
    readDecision = readDecisionReaderSource,
    caseLawDb,
  }: ReaderAnswerCorpusDependencies = {},
) =>
  Result.tryPromise({
    try: async (): Promise<ReaderAnswerDecision | null> => {
      const read = await readDecision({
        decisionId,
        phase: "blocks",
        audience: "model",
        ...(caseLawDb === undefined ? {} : { caseLawDb }),
      });
      if (read?.status !== "read" || read.ast === null) {
        return null;
      }
      return {
        decisionId: read.decision.id,
        paragraphs: read.ast.blocks.flatMap((block) =>
          block.type === "paragraph"
            ? [
                {
                  paragraphId: block.anchorId,
                  text: plainTextOf(block.inlines),
                },
              ]
            : [],
        ),
      };
    },
    catch: (cause) =>
      new ReaderAnswerCorpusError({
        message: "Could not read the decision",
        cause,
      }),
  });

export type ReadReaderAnswerRelatedOptions = {
  decisionId: SafeId<"caseLawDecision">;
  paragraphId: string;
  direction: ReaderAnswerRelatedDirection;
  query: string;
};

const queryTerms = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu));

/** User-derived ranking lives only in this call; no cache receives the query or excerpts. */
export const readReaderAnswerRelated = async (
  { decisionId, paragraphId, direction, query }: ReadReaderAnswerRelatedOptions,
  {
    readRelatedIds = readRelatedDecisionIds,
    ...dependencies
  }: ReaderAnswerCorpusDependencies = {},
) =>
  Result.tryPromise({
    try: async (): Promise<ReaderAnswerRelatedExcerpt[]> => {
      const origin = await readReaderAnswerDecision(decisionId, dependencies);
      if (origin.isErr()) {
        throw origin.error;
      }
      const anchor = origin.value?.paragraphs.find(
        (paragraph) => paragraph.paragraphId === paragraphId,
      );
      if (anchor === undefined) {
        return [];
      }
      const ids = await readRelatedIds(
        decisionId,
        direction,
        dependencies.caseLawDb,
      );
      const terms = queryTerms(
        `${anchor.text.slice(0, READER_ANSWER_RELATED_LIMITS.queryChars)} ${query.slice(0, READER_ANSWER_RELATED_LIMITS.queryChars)}`,
      );
      const ranked: {
        excerpt: ReaderAnswerRelatedExcerpt;
        score: number;
        order: number;
      }[] = [];
      // Only the fixed candidate budget enters the reader; every target is admitted independently.
      for (const id of (ids ?? []).slice(
        0,
        READER_ANSWER_RELATED_LIMITS.decisions,
      )) {
        const read = await readReaderAnswerDecision(id, dependencies);
        if (read.isErr()) {
          throw read.error;
        }
        if (read.value === null) {
          continue;
        }
        for (const paragraph of read.value.paragraphs) {
          if (paragraph.text.trim().length === 0) {
            continue;
          }
          const words = queryTerms(paragraph.text);
          let score = 0;
          for (const term of terms) {
            if (words.has(term)) {
              score++;
            }
          }
          ranked.push({
            excerpt: {
              decisionId: read.value.decisionId,
              paragraphId: paragraph.paragraphId,
              text: paragraph.text.slice(
                0,
                READER_ANSWER_RELATED_LIMITS.excerptChars,
              ),
            },
            score,
            order: ranked.length,
          });
        }
      }
      ranked.sort(
        (left, right) => right.score - left.score || left.order - right.order,
      );
      const seen = new Set<string>();
      return ranked
        .filter(({ excerpt }) => {
          const key = JSON.stringify([excerpt.decisionId, excerpt.paragraphId]);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .slice(0, READER_ANSWER_RELATED_LIMITS.paragraphs)
        .map(({ excerpt }) => excerpt);
    },
    catch: (cause) =>
      new ReaderAnswerCorpusError({
        message: "Could not read related decision excerpts",
        cause,
      }),
  });
