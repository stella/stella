import { panic, Result, TaggedError } from "better-result";

import { visibleReaderAnchorPiecesOf } from "@stll/legal-ast/case-law-reader";

import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  listIncomingDecisionCitations,
  listOutgoingDecisionCitations,
} from "@/api/lib/case-law/decision-citations";
import { decisionWorkOf } from "@/api/lib/case-law/decision-work";
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

type ReaderAnswerParagraph = { paragraphId: string; text: string };
export type ReaderAnswerDecision = {
  decisionId: SafeId<"caseLawDecision">;
  paragraphs: ReaderAnswerParagraph[];
  decisionDate: string | null;
  court: string | null;
};
export type ReaderAnswerRelatedDirection = "cited" | "citing" | "both";
type ReaderAnswerRelatedCandidate = {
  decisionId: SafeId<"caseLawDecision">;
  direction: Exclude<ReaderAnswerRelatedDirection, "both">;
};
export type ReaderAnswerRelatedExcerpt = ReaderAnswerParagraph &
  ReaderAnswerRelatedCandidate &
  Pick<ReaderAnswerDecision, "court" | "decisionDate">;

const readRelatedDecisionCandidates = async (
  decisionId: SafeId<"caseLawDecision">,
  direction: ReaderAnswerRelatedDirection,
  caseLawDb = caseLawPublicReadDb,
) =>
  await withRedistributableSubject(
    caseLawDb,
    "search",
    { kind: "id", id: decisionId },
    async (subject) => {
      const { tx, countries } = subject;
      const work = await decisionWorkOf(subject);
      const [outgoing, incoming] = await Promise.all([
        direction === "citing"
          ? null
          : listOutgoingDecisionCitations({
              tx,
              work,
              cursor: undefined,
              countries,
            }),
        direction === "cited"
          ? null
          : listIncomingDecisionCitations({
              tx,
              work,
              cursor: undefined,
              countries,
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
      const candidates: ReaderAnswerRelatedCandidate[] = [];
      const seen = new Set<string>();
      const outgoingCandidates =
        outgoing === null
          ? []
          : outgoing.items.flatMap((row) =>
              row.citedDecisionId === null
                ? []
                : [
                    {
                      decisionId: row.citedDecisionId,
                      direction: "cited" as const,
                    },
                  ],
            );
      const incomingCandidates =
        incoming === null
          ? []
          : incoming.items.map((row) => ({
              decisionId: row.citingDecisionId,
              direction: "citing" as const,
            }));
      for (
        let index = 0;
        index < Math.max(outgoingCandidates.length, incomingCandidates.length);
        index++
      ) {
        for (const candidate of [
          outgoingCandidates.at(index),
          incomingCandidates.at(index),
        ]) {
          if (
            candidate === undefined ||
            work.manifestationIds.includes(candidate.decisionId)
          ) {
            continue;
          }
          const key = JSON.stringify([
            candidate.decisionId,
            candidate.direction,
          ]);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          candidates.push(candidate);
          if (candidates.length === READER_ANSWER_RELATED_LIMITS.decisions) {
            return candidates;
          }
        }
      }
      return candidates;
    },
  );

export type ReaderAnswerCorpusDependencies = {
  caseLawDb?: CaseLawPublicReadDb;
  readDecision?: typeof readDecisionReaderSource;
  readRelatedCandidates?: typeof readRelatedDecisionCandidates;
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
        surface: "search",
        ...(caseLawDb === undefined ? {} : { caseLawDb }),
      });
      if (read?.status !== "read" || read.ast === null) {
        return null;
      }
      return {
        decisionId: read.decision.id,
        court: read.decision.court,
        decisionDate: read.decision.decisionDate,
        // Exactly the pieces the reader shows, headings and table cells
        // included: an Explain over any of them resolves, and the model
        // never reads or cites text the reader hides.
        paragraphs: visibleReaderAnchorPiecesOf(
          read.ast,
          read.decision.caseNumberType,
        ).map(({ anchorId, text }) => ({ paragraphId: anchorId, text })),
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
    readRelatedCandidates = readRelatedDecisionCandidates,
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
      const candidates = yield* await Result.tryPromise({
        try: async () =>
          await readRelatedCandidates(
            decisionId,
            direction,
            dependencies.caseLawDb,
          ),
        catch: (cause) => cause,
      });
      if (candidates === null) {
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
      for (const candidate of candidates
        .filter(
          ({ direction: candidateDirection }) =>
            direction === "both" || candidateDirection === direction,
        )
        .slice(0, READER_ANSWER_RELATED_LIMITS.decisions)) {
        const read = yield* await readReaderAnswerDecision(
          candidate.decisionId,
          dependencies,
        );
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
              direction: candidate.direction,
              court: read.court,
              decisionDate: read.decisionDate,
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
      const unique = ranked.filter(({ excerpt }) => {
        const key = JSON.stringify([
          excerpt.decisionId,
          excerpt.paragraphId,
          excerpt.direction,
        ]);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      if (direction !== "both") {
        return Result.ok(
          unique
            .slice(0, READER_ANSWER_RELATED_LIMITS.paragraphs)
            .map(({ excerpt }) => excerpt),
        );
      }
      // Rank within each direction before interleaving: strong precedent matches
      // cannot consume the entire excerpt budget and hide later citing decisions.
      const cited = unique.filter(
        ({ excerpt }) => excerpt.direction === "cited",
      );
      const citing = unique.filter(
        ({ excerpt }) => excerpt.direction === "citing",
      );
      const excerpts: ReaderAnswerRelatedExcerpt[] = [];
      for (
        let index = 0;
        index < Math.max(cited.length, citing.length);
        index++
      ) {
        for (const candidate of [cited.at(index), citing.at(index)]) {
          if (candidate === undefined) {
            continue;
          }
          excerpts.push(candidate.excerpt);
          if (excerpts.length === READER_ANSWER_RELATED_LIMITS.paragraphs) {
            return Result.ok(excerpts);
          }
        }
      }
      return Result.ok(excerpts);
    })
  ).mapError(
    (cause) =>
      new ReaderAnswerCorpusError({
        message: "Could not read related decision excerpts",
        cause,
      }),
  );
