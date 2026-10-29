import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { containPayloadUnavailable } from "@/api/handlers/case-law/decisions/get";
import { readServedDecisionAst } from "@/api/handlers/case-law/decisions/served-ast";
import { createSafeId } from "@/api/lib/branded-types";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { StoredCorpusValidationError } from "@/api/lib/errors/tagged-errors";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import { logger } from "@/api/lib/observability/logger";

// Historical parser output can repeat a section anchor despite distinct block ids.
const duplicateAnchors = {
  version: 1,
  blocks: ["first", "second"].map((id) => ({
    id,
    anchorId: "section-1",
    type: "paragraph",
    inlines: [{ type: "text", text: "Synthetic private decision text" }],
  })),
};

const decisionId = createSafeId<"caseLawDecision">();

describe("invalid stored decision payloads", () => {
  test("classifies historical duplicate anchors without retaining decision content", () => {
    const parsed = Result.try({
      try: () => parsePersistedCorpusAst(duplicateAnchors),
      catch: (error: unknown) => error,
    });
    expect(parsed.isErr()).toBe(true);
    if (!parsed.isErr()) {
      return expect.unreachable();
    }
    expect(parsed.error).toBeInstanceOf(StoredCorpusValidationError);
    expect(parsed.error).toMatchObject({
      code: "stored_corpus_invalid",
      paths: ["$"],
    });
    expect(JSON.stringify(parsed.error)).not.toContain("Synthetic private");
  });

  test("records nested issue paths instead of rejected values", () => {
    const parsed = Result.try({
      try: () =>
        parsePersistedCorpusAst({
          version: 1,
          blocks: [{ type: "paragraph" }],
        }),
      catch: (error: unknown) => error,
    });
    expect(parsed.isErr()).toBe(true);
    if (!parsed.isErr()) {
      return expect.unreachable();
    }
    expect(parsed.error).toMatchObject({
      paths: expect.arrayContaining([
        "blocks.0.id",
        "blocks.0.anchorId",
        "blocks.0.inlines",
      ]),
    });
  });

  // Summary and citation passages share the analysis reader; web, MCP blocks,
  // and MCP outlines share the served reader through readDecisionHandler.
  test.each([
    {
      surface: "summary and citation passages",
      read: async () =>
        await readDecisionAnalysisAst(
          {
            id: decisionId,
            astS3Key: null,
            contentHash: null,
            documentAst: duplicateAnchors,
          },
          async () => new Set<string>(),
        ),
    },
    {
      surface: "canonical object storage",
      read: async () =>
        await readCorpusPayloadOrFallback({
          documentId: decisionId,
          key: "synthetic-ast-key",
          step: "test.storedValidation",
          read: async () => parsePersistedCorpusAst(duplicateAnchors),
          fallback: () => null,
        }),
    },
    {
      surface: "web and MCP blocks and outline",
      read: async () =>
        await readServedDecisionAst({
          astS3Key: null,
          contentHash: null,
          pgAst: duplicateAnchors,
          decisionId,
          corpusReadEnabled: false,
          readStore: async () => null,
        }),
    },
  ])(
    "classifies the $surface reader failure and logs its id",
    async ({ read }) => {
      const report = spyOn(logger, "error");
      try {
        const outcome = await containPayloadUnavailable(async () => {
          await read();
          return "read";
        }, decisionId);
        expect(outcome).toEqual({ payload: null, unavailable: true });
        expect(report).toHaveBeenCalledWith(
          "case_law.decision.stored_payload_invalid",
          { decisionId, code: "stored_corpus_invalid", paths: ["$"] },
        );
        expect(JSON.stringify(report.mock.calls)).not.toContain(
          "Synthetic private",
        );
      } finally {
        report.mockRestore();
      }
    },
  );
});
