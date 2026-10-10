import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

import {
  readReaderAnswerDecision,
  readReaderAnswerRelated,
  READER_ANSWER_RELATED_LIMITS,
  ReaderAnswerCorpusError,
} from "./reader-answer-corpus";

type FixtureOptions = {
  decisionId: SafeId<"caseLawDecision">;
  texts: string[];
};
const source = ({ decisionId, texts }: FixtureOptions) =>
  ({
    status: "read",
    decision: {
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
      paragraphs: [{ paragraphId: "paragraph-0", text: "Civil liability" }],
    });
  });

  test("bounds candidates and returned excerpts while ranking relevant paragraphs first", async () => {
    const decisionId = createSafeId<"caseLawDecision">();
    const candidates = Array.from(
      { length: READER_ANSWER_RELATED_LIMITS.decisions + 4 },
      () => createSafeId<"caseLawDecision">(),
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
        readRelatedIds: async (id, direction) => {
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
      ...candidates.slice(0, READER_ANSWER_RELATED_LIMITS.decisions),
    ]);
    expect(result.value).toHaveLength(READER_ANSWER_RELATED_LIMITS.paragraphs);
    for (const excerpt of result.value) {
      expect(excerpt.paragraphId).toBe("paragraph-1");
      expect(excerpt.text.length).toBeLessThanOrEqual(
        READER_ANSWER_RELATED_LIMITS.excerptChars,
      );
      expect(
        candidates.slice(0, READER_ANSWER_RELATED_LIMITS.decisions),
      ).toContain(excerpt.decisionId);
    }
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
        readRelatedIds: async () => {
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
        readRelatedIds: async () => [withheld, readable, readable],
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
        paragraphId: "paragraph-0",
        text: "Civil liability",
      },
    ]);
  });

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
        readRelatedIds: async () => {
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
