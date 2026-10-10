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
        outgoing === null
          ? []
          : outgoing.items.flatMap((row) =>
              row.citedDecisionId === null ? [] : [row.citedDecisionId],
            );
      const incomingIds =
        incoming === null
          ? []
          : incoming.items.map((row) => row.citingDecisionId);
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

const READER_ANSWER_WORD_PATTERN = /[\p{L}\p{N}]{3,}/gu;
const queryTerms = (text: string) =>
  new Set(
    Array.from(text.matchAll(READER_ANSWER_WORD_PATTERN), (match) =>
      match[0].toLowerCase(),
    ),
  );

/** User-derived ranking lives only in this call; no cache receives the query or excerpts. */
export const readReaderAnswerRelated = async (
  { decisionId, paragraphId, direction, query }: ReadReaderAnswerRelatedOptions,
  {
    readRelatedIds = readRelatedDecisionIds,
    ...dependencies
  }: ReaderAnswerCorpusDependencies = {},
) =>
  (
    await Result.gen(async function* () {
      const origin = yield* await readReaderAnswerDecision(
        decisionId,
        dependencies,
      );
      const anchor = origin?.paragraphs.find(
        (paragraph) => paragraph.paragraphId === paragraphId,
      );
      if (anchor === undefined) {
        return Result.ok([]);
      }
      const ids = yield* await Result.tryPromise({
        try: async () =>
          await readRelatedIds(decisionId, direction, dependencies.caseLawDb),
        catch: (cause) => cause,
      });
      if (ids === null) {
        return Result.ok([]);
      }
      const terms = queryTerms(
        `${anchor.text.slice(0, READER_ANSWER_RELATED_LIMITS.queryChars)} ${query.slice(0, READER_ANSWER_RELATED_LIMITS.queryChars)}`,
      );
      const ranked: {
        excerpt: ReaderAnswerRelatedExcerpt;
        score: number;
        order: number;
      }[] = [];
      // Only the fixed candidate budget enters the reader; every target is admitted independently.
      for (const id of ids.slice(0, READER_ANSWER_RELATED_LIMITS.decisions)) {
        const read = yield* await readReaderAnswerDecision(id, dependencies);
        if (read === null) {
          continue;
        }
        for (const paragraph of read.paragraphs) {
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
          const matches = Array.from(
            paragraph.text.matchAll(READER_ANSWER_WORD_PATTERN),
          ).filter((match) => terms.has(match[0].toLowerCase()));
          const windowTerms = new Map<string, number>();
          let left = 0;
          let right = 0;
          let excerptStart = 0;
          let excerptScore = 0;
          for (const match of matches) {
            const start = Math.min(
              Math.max(
                0,
                match.index - READER_ANSWER_RELATED_LIMITS.excerptChars / 2,
              ),
              Math.max(
                0,
                paragraph.text.length -
                  READER_ANSWER_RELATED_LIMITS.excerptChars,
              ),
            );
            const end = start + READER_ANSWER_RELATED_LIMITS.excerptChars;
            while (true) {
              const next = matches.at(right);
              if (next === undefined || next.index + next[0].length > end) {
                break;
              }
              const term = next[0].toLowerCase();
              windowTerms.set(term, (windowTerms.get(term) ?? 0) + 1);
              right++;
            }
            while (left < right) {
              const previous =
                matches.at(left) ??
                panic("Excerpt window cursor exceeds its matched tokens");
              if (previous.index >= start) {
                break;
              }
              const term = previous[0].toLowerCase();
              const remaining =
                (windowTerms.get(term) ??
                  panic("Excerpt window is missing a counted term")) - 1;
              if (remaining === 0) {
                windowTerms.delete(term);
              } else {
                windowTerms.set(term, remaining);
              }
              left++;
            }
            if (windowTerms.size > excerptScore) {
              excerptStart = start;
              excerptScore = windowTerms.size;
            }
          }
          ranked.push({
            excerpt: {
              decisionId: read.decisionId,
              paragraphId: paragraph.paragraphId,
              text: paragraph.text.slice(
                excerptStart,
                excerptStart + READER_ANSWER_RELATED_LIMITS.excerptChars,
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
      return Result.ok(
        ranked
          .filter(({ excerpt }) => {
            const key = JSON.stringify([
              excerpt.decisionId,
              excerpt.paragraphId,
            ]);
            if (seen.has(key)) {
              return false;
            }
            seen.add(key);
            return true;
          })
          .slice(0, READER_ANSWER_RELATED_LIMITS.paragraphs)
          .map(({ excerpt }) => excerpt),
      );
    })
  ).mapError(
    (cause) =>
      new ReaderAnswerCorpusError({
        message: "Could not read related decision excerpts",
        cause,
      }),
  );
