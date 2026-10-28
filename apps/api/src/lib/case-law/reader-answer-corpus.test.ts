import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { noDecisionReviewFound } from "@stll/api-contract/case-law-reviews";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

import {
  READER_ANSWER_RELATED_LIMITS,
  ReaderAnswerCorpusError,
  readReaderAnswerDecision,
  readReaderAnswerRelated,
} from "./reader-answer-corpus";

type FixtureOptions = {
  decisionId: SafeId<"caseLawDecision">;
  texts: string[];
};
const source = ({ decisionId, texts }: FixtureOptions) =>
  ({
    status: "read",
    decision: {
      appealReviews: noDecisionReviewFound(),
      id: decisionId,
      caseNumberType: "case-number",
      courtAbbreviation: "ÚS",
      courtTier: "constitutional",
      caseNumber: "1 Test 2026",
      court: "Test court",
      country: "CZE",
      decisionDate: "2026-01-01",
      ecli: null,
      language: "cs",
      languageAlternates: [],
      slug: null,
    },
    textAccess: "readable",
    ast: {
      version: 1,
      source: {
        system: "test",
        documentId: decisionId,
        webUrl: "",
        printUrl: "",
      },
      metadata: {
        caseNumber: "1 Test 2026",
        ecli: null,
        court: "Test court",
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: texts.map((text, index) => ({
        type: "paragraph",
        id: `block-${index}`,
        anchorId: `paragraph-${index}`,
        plainText: text,
        inlines: [{ type: "text", text }],
      })),
    } satisfies DocumentAst,
    citationAnchors: [],
    provisionAnchors: [],
    provisionStatus: null,
    referenceNextCursor: null,
  }) as const satisfies NonNullable<
    Awaited<ReturnType<typeof readDecisionReaderSource>>
  >;

describe("private reader answer corpus excerpts", () => {
  test("uses the model reader audience and paragraph projection", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const result = await readReaderAnswerDecision(decisionId, {
      readDecision: async (options) => {
        expect(options).toEqual({
          decisionId,
          audience: "model",
          phase: "blocks",
          surface: "search",
        });
        return source({ decisionId, texts: ["Civil liability"] });
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toEqual({
      decisionId,
      decisionDate: "2026-01-01",
      court: "Test court",
      paragraphs: [{ paragraphId: "paragraph-0", text: "Civil liability" }],
    });
  });

  test("projects every piece a reader selection can anchor to", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const read = source({ decisionId, texts: ["Civil liability"] });
    const result = await readReaderAnswerDecision(decisionId, {
      readDecision: async () => ({
        ...read,
        ast: {
          ...read.ast,
          blocks: [
            {
              type: "heading",
              id: "block-heading",
              anchorId: "heading-1",
              level: 2,
              plainText: "Reasoning",
              inlines: [{ type: "text", text: "Reasoning" }],
            },
            ...read.ast.blocks,
            {
              type: "table",
              id: "block-table",
              anchorId: "table-1",
              plainText: "Claim Damages",
              rows: [
                [
                  {
                    plainText: "Claim",
                    inlines: [{ type: "text", text: "Claim" }],
                  },
                  {
                    plainText: "Damages",
                    inlines: [{ type: "text", text: "Damages" }],
                  },
                ],
              ],
            },
            {
              type: "image",
              id: "block-image",
              anchorId: "image-1",
              src: "https://assets.example/seal.png",
              plainText: "Seal",
            },
          ],
        },
      }),
    });
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value?.paragraphs).toEqual([
      { paragraphId: "heading-1", text: "Reasoning" },
      { paragraphId: "paragraph-0", text: "Civil liability" },
      { paragraphId: "table:block-table:0:0", text: "Claim" },
      { paragraphId: "table:block-table:0:1", text: "Damages" },
    ]);
  });

  test("leaves out what the reader hides: related proceedings and the docket header", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const read = source({ decisionId, texts: ["Civil liability"] });
    const result = await readReaderAnswerDecision(decisionId, {
      readDecision: async () => ({
        ...read,
        ast: {
          ...read.ast,
          blocks: [
            {
              type: "paragraph",
              id: "block-docket",
              anchorId: "docket-1",
              role: "case-number",
              plainText: "1 Test 2026",
              inlines: [{ type: "text", text: "1 Test 2026" }],
            },
            ...read.ast.blocks,
            {
              type: "table",
              id: "block-related",
              anchorId: "related-1",
              role: "related-proceedings",
              plainText: "2 Co 3/2025",
              rows: [
                [
                  {
                    plainText: "2 Co 3/2025",
                    inlines: [{ type: "text", text: "2 Co 3/2025" }],
                  },
                ],
              ],
            },
            {
              type: "table",
              id: "block-table",
              anchorId: "table-1",
              plainText: "Claim",
              rows: [
                [
                  {
                    plainText: "Claim",
                    inlines: [{ type: "text", text: "Claim" }],
                  },
                ],
              ],
            },
          ],
        },
      }),
    });
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value?.paragraphs).toEqual([
      { paragraphId: "paragraph-0", text: "Civil liability" },
      { paragraphId: "table:block-table:0:0", text: "Claim" },
    ]);
  });

  test("bounds candidates and returned excerpts while ranking relevant paragraphs first", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const candidates = Array.from(
      { length: READER_ANSWER_RELATED_LIMITS.decisions + 4 },
      (_, index) => ({
        decisionId: createSafeId<"caseLawDecision">(),
        direction: index % 2 === 0 ? ("cited" as const) : ("citing" as const),
      }),
    );
    const reads: SafeId<"caseLawDecision">[] = [];
    const result = await readReaderAnswerRelated(
      {
        decisionId,
        paragraphId: "paragraph-0",
        direction: "both",
        query: "damages",
      },
      {
        readRelatedCandidates: async (id, direction) => {
          expect(id).toBe(decisionId);
          expect(direction).toBe("both");
          return candidates;
        },
        readDecision: async ({ decisionId: id }) => {
          reads.push(id);
          return source({
            decisionId: id,
            texts:
              id === decisionId
                ? ["Civil liability"]
                : [
                    "Unrelated appeal",
                    `Civil liability damages ${"passage ".repeat(500)}`,
                  ],
          });
        },
      },
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(reads).toEqual([
      decisionId,
      ...candidates
        .slice(0, READER_ANSWER_RELATED_LIMITS.decisions)
        .map((candidate) => candidate.decisionId),
    ]);
    expect(result.value).toHaveLength(READER_ANSWER_RELATED_LIMITS.paragraphs);
    for (const excerpt of result.value) {
      expect(excerpt.paragraphId).toBe("paragraph-1");
      expect(excerpt.text.length).toBeLessThanOrEqual(
        READER_ANSWER_RELATED_LIMITS.excerptChars,
      );
      expect(
        candidates
          .slice(0, READER_ANSWER_RELATED_LIMITS.decisions)
          .map((candidate) => candidate.decisionId),
      ).toContain(excerpt.decisionId);
    }
  });

  test("returns the strongest matching window beyond the paragraph prefix", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const relatedId = createSafeId<"caseLawDecision">();
    const relevant = "liability damages negligence";
    const text = `Civil ${"İstanbul background ".repeat(900)}${relevant} ${"reasoning ".repeat(200)}`;
    expect(text.indexOf(relevant)).toBeGreaterThan(
      READER_ANSWER_RELATED_LIMITS.excerptChars,
    );
    const result = await readReaderAnswerRelated(
      {
        decisionId,
        paragraphId: "paragraph-0",
        direction: "cited",
        query: "damages negligence",
      },
      {
        readRelatedCandidates: async (_id, direction) => {
          expect(direction).toBe("cited");
          return [{ decisionId: relatedId, direction: "cited" }];
        },
        readDecision: async ({ decisionId: id }) =>
          source({
            decisionId: id,
            texts: [id === decisionId ? "Civil liability" : text],
          }),
      },
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toHaveLength(1);
    expect(result.value.at(0)?.decisionId).toBe(relatedId);
    expect(result.value.at(0)?.paragraphId).toBe("paragraph-0");
    expect(result.value.at(0)).toMatchObject({
      direction: "cited",
      decisionDate: "2026-01-01",
      court: "Test court",
    });
    expect(result.value.at(0)?.text).toContain(relevant);
    expect(result.value.at(0)?.text.length).toBeLessThanOrEqual(
      READER_ANSWER_RELATED_LIMITS.excerptChars,
    );
  });

  test("missing anchor cannot trigger graph or related reads", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    let graphReads = 0;
    const result = await readReaderAnswerRelated(
      {
        decisionId,
        paragraphId: "invented",
        direction: "both",
        query: "question",
      },
      {
        readDecision: async () => source({ decisionId, texts: ["Passage"] }),
        readRelatedCandidates: async () => {
          graphReads++;
          return [];
        },
      },
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toEqual([]);
    expect(graphReads).toBe(0);
  });

  test("withheld targets never contribute text or citation pairs", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const withheld = createSafeId<"caseLawDecision">();
    const readable = createSafeId<"caseLawDecision">();
    const result = await readReaderAnswerRelated(
      {
        decisionId,
        paragraphId: "paragraph-0",
        direction: "cited",
        query: "liability",
      },
      {
        readRelatedCandidates: async (_id, direction) => {
          expect(direction).toBe("cited");
          return [withheld, readable, readable].map((candidate) => ({
            decisionId: candidate,
            direction: "cited" as const,
          }));
        },
        readDecision: async ({ decisionId: id }) =>
          id === withheld
            ? {
                ...source({ decisionId: id, texts: ["Protected"] }),
                textAccess: "withheld",
                ast: null,
              }
            : source({ decisionId: id, texts: ["Civil liability"] }),
      },
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toEqual([
      {
        decisionId: readable,
        direction: "cited",
        decisionDate: "2026-01-01",
        court: "Test court",
        paragraphId: "paragraph-0",
        text: "Civil liability",
      },
    ]);
  });

  test.each(["cited", "citing"] as const)(
    "opposite high-scoring candidates cannot crowd the requested %s direction",
    async (direction) => {
      const decisionId = createSafeId<"caseLawDecision">();
      const requestedId = createSafeId<"caseLawDecision">();
      const oppositeDirection =
        direction === "cited" ? ("citing" as const) : ("cited" as const);
      const opposite = Array.from(
        { length: READER_ANSWER_RELATED_LIMITS.decisions + 2 },
        () => ({
          decisionId: createSafeId<"caseLawDecision">(),
          direction: oppositeDirection,
        }),
      );
      expect(opposite.length).toBeGreaterThan(
        READER_ANSWER_RELATED_LIMITS.decisions,
      );
      const reads: SafeId<"caseLawDecision">[] = [];
      const result = await readReaderAnswerRelated(
        {
          decisionId,
          paragraphId: "paragraph-0",
          direction,
          query: "liability damages negligence remedy",
        },
        {
          readRelatedCandidates: async (_id, requestedDirection) => {
            expect(requestedDirection).toBe(direction);
            return [...opposite, { decisionId: requestedId, direction }];
          },
          readDecision: async ({ decisionId: id }) => {
            reads.push(id);
            if (id === decisionId) {
              return source({ decisionId: id, texts: ["Liability"] });
            }
            if (id === requestedId) {
              return source({ decisionId: id, texts: ["Liability rule"] });
            }
            return source({
              decisionId: id,
              texts: ["Liability damages negligence remedy"],
            });
          },
        },
      );
      if (result.isErr()) {
        throw result.error;
      }
      expect(reads).toEqual([decisionId, requestedId]);
      expect(result.value).toEqual([
        {
          decisionId: requestedId,
          direction,
          decisionDate: "2026-01-01",
          court: "Test court",
          paragraphId: "paragraph-0",
          text: "Liability rule",
        },
      ]);
    },
  );

  test.each(["cited", "citing"] as const)(
    "the both-direction cap reserves the strongest paragraph outside the dominant %s direction",
    async (dominantDirection) => {
      const decisionId = createSafeId<"caseLawDecision">();
      const dominantId = createSafeId<"caseLawDecision">();
      const otherId = createSafeId<"caseLawDecision">();
      const otherDirection =
        dominantDirection === "cited"
          ? ("citing" as const)
          : ("cited" as const);
      const dominantParagraphs = Array.from(
        { length: READER_ANSWER_RELATED_LIMITS.paragraphs + 2 },
        (_, index) => `Liability damages negligence remedy ${String(index)}`,
      );
      expect(dominantParagraphs.length).toBeGreaterThan(
        READER_ANSWER_RELATED_LIMITS.paragraphs,
      );
      const result = await readReaderAnswerRelated(
        {
          decisionId,
          paragraphId: "paragraph-0",
          direction: "both",
          query: "damages negligence remedy",
        },
        {
          readRelatedCandidates: async (_id, direction) => {
            expect(direction).toBe("both");
            return [
              { decisionId: dominantId, direction: dominantDirection },
              { decisionId: otherId, direction: otherDirection },
            ];
          },
          readDecision: async ({ decisionId: id }) => {
            if (id === decisionId) {
              return source({ decisionId: id, texts: ["Liability"] });
            }
            if (id === dominantId) {
              return source({ decisionId: id, texts: dominantParagraphs });
            }
            return source({
              decisionId: id,
              texts: ["Unrelated appeal", "Liability damages"],
            });
          },
        },
      );
      if (result.isErr()) {
        throw result.error;
      }
      expect(result.value).toHaveLength(
        READER_ANSWER_RELATED_LIMITS.paragraphs,
      );
      expect(result.value).toContainEqual({
        decisionId: dominantId,
        direction: dominantDirection,
        decisionDate: "2026-01-01",
        court: "Test court",
        paragraphId: "paragraph-0",
        text:
          dominantParagraphs.at(0) ??
          panic("Dominant paragraph fixture is empty"),
      });
      expect(result.value).toContainEqual({
        decisionId: otherId,
        direction: otherDirection,
        decisionDate: "2026-01-01",
        court: "Test court",
        paragraphId: "paragraph-1",
        text: "Liability damages",
      });
    },
  );

  test("read failures remain typed failures rather than empty tool results", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const failure = new ReaderAnswerCorpusError({
      message: "Fixture read failure",
      cause: null,
    });
    const result = await readReaderAnswerRelated(
      {
        decisionId,
        paragraphId: "paragraph-0",
        direction: "citing",
        query: "question",
      },
      {
        readDecision: async () => source({ decisionId, texts: ["Passage"] }),
        readRelatedCandidates: async () => {
          throw failure;
        },
      },
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new ReaderAnswerCorpusError({
        message: "Expected corpus failure",
        cause: null,
      });
    }
    expect(result.error).toBeInstanceOf(ReaderAnswerCorpusError);
    expect(result.error.cause).toBe(failure);
  });
});
