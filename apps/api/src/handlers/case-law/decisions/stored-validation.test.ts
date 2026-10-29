import { Result } from "better-result";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { containPayloadUnavailable } from "@/api/handlers/case-law/decisions/get";
import { readServedDecisionAst } from "@/api/handlers/case-law/decisions/served-ast";
import * as captureModule from "@/api/lib/analytics/capture";
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

// A paragraph without the fields every block requires; valibot reports these
// inside union issues, relative to the block they belong to.
const missingBlockFields = { version: 1, blocks: [{ type: "paragraph" }] };

const validationFailureOf = (
  value: unknown,
  documentId?: string,
): StoredCorpusValidationError => {
  const parsed = Result.try({
    try: () => parsePersistedCorpusAst(value, documentId),
    catch: (error: unknown) => error,
  });
  if (parsed.isOk()) {
    return expect.unreachable("the stored payload unexpectedly parsed");
  }
  expect(parsed.error).toBeInstanceOf(StoredCorpusValidationError);
  if (!StoredCorpusValidationError.is(parsed.error)) {
    return expect.unreachable("the parser raised an unclassified failure");
  }
  return parsed.error;
};

/** Record both reporting channels, silenced, for one test. */
const recordReports = () => ({
  logged: spyOn(logger, "error").mockImplementation(() => undefined),
  captured: spyOn(captureModule, "captureObservedError").mockImplementation(
    () => undefined,
  ),
});

const expectStoredValidationLog = (
  logged: ReturnType<typeof recordReports>["logged"],
): void => {
  expect(logged).toHaveBeenCalledTimes(1);
  expect(logged).toHaveBeenCalledWith(
    "case_law.decision.stored_payload_invalid",
    expect.objectContaining({
      decisionId,
      "error.code": "stored_corpus_invalid",
      "error.type": "StoredCorpusValidationError",
      "failure.sink": "case_law.decision.stored_payload_invalid",
    }),
  );
};

afterEach(() => {
  mock.restore();
});

describe("invalid stored decision payloads", () => {
  test("classifies historical duplicate anchors without retaining decision content", () => {
    const error = validationFailureOf(duplicateAnchors);
    expect(error).toMatchObject({
      code: "stored_corpus_invalid",
      paths: ["$"],
    });
    expect(JSON.stringify(error)).not.toContain("Synthetic private");
  });

  test("records nested issue paths from the payload root instead of rejected values", () => {
    const error = validationFailureOf(missingBlockFields);
    expect(error.paths).toEqual(
      expect.arrayContaining([
        "blocks.0",
        "blocks.0.id",
        "blocks.0.anchorId",
        "blocks.0.inlines",
      ]),
    );
    // A nested issue never appears under a path relative to its union.
    expect(error.paths).not.toContain("id");
    expect(error.paths).not.toContain("anchorId");
  });

  test("reports a row parse once with the paths the error carries", () => {
    const { logged, captured } = recordReports();
    const error = validationFailureOf(missingBlockFields, decisionId);
    expectStoredValidationLog(logged);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0]?.[0]).toBe(error);
  });

  test("an unidentified parse leaves reporting to its reader", () => {
    const { logged, captured } = recordReports();
    validationFailureOf(missingBlockFields);
    expect(logged).not.toHaveBeenCalled();
    expect(captured).not.toHaveBeenCalled();
  });

  test("an invalid stored object served from the row copy is reported once", async () => {
    const { logged, captured } = recordReports();
    const served = await readCorpusPayloadOrFallback({
      documentId: decisionId,
      key: "synthetic-ast-key",
      step: "test.storedValidation",
      read: async () => parsePersistedCorpusAst(duplicateAnchors),
      fallback: () =>
        parsePersistedCorpusAst({ version: 1, blocks: [] }, decisionId),
    });
    expect(served).toMatchObject({ version: 1, blocks: [] });
    expectStoredValidationLog(logged);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0]?.[0]).toBeInstanceOf(
      StoredCorpusValidationError,
    );
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
    "contains the $surface reader failure and reports it once",
    async ({ read }) => {
      const { logged, captured } = recordReports();
      const outcome = await containPayloadUnavailable(async () => {
        await read();
        return "read";
      }, decisionId);
      expect(outcome).toEqual({ payload: null, unavailable: true });
      expectStoredValidationLog(logged);
      expect(captured).toHaveBeenCalledTimes(1);
      expect(captured.mock.calls[0]?.[0]).toBeInstanceOf(
        StoredCorpusValidationError,
      );
      expect(JSON.stringify(logged.mock.calls)).not.toContain(
        "Synthetic private",
      );
    },
  );
});
