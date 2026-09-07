/**
 * What the three decision-analysis scripts refuse, and what they accept.
 *
 * The scripts run under an operator against the live corpus, so every
 * refusal is exercised here instead: a redacted row, a source whose terms
 * withhold derived AI use, a parse this database-only login cannot reach,
 * and a submission carrying the graph-fenced layer it may not write.
 */

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  ANALYSIS_REJECTION,
  describeUpdateOutcome,
  flagValue,
  hasFlag,
  nonNegativeInteger,
  parseIdsFile,
  parseSubmissionFile,
  parseSubmissionRecord,
  positiveInteger,
  readAnalysisDatabaseUrl,
  resolveRowAnalysisInput,
  type DecisionAnalysisRow,
} from "./decision-analysis.logic";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "00000000-0000-0000-0000-0000000000c1",
);

const paragraph = (anchorId: string, plainText: string) => ({
  id: anchorId,
  anchorId,
  type: "paragraph",
  plainText,
  inlines: [{ type: "text", text: plainText }],
});

const documentAst = {
  version: 1,
  blocks: [
    paragraph("b1", "Rozsudek"),
    paragraph("b2", "Soud dovolání zamítl."),
  ],
};

const row = (
  overrides: Partial<DecisionAnalysisRow> = {},
): DecisionAnalysisRow => ({
  id: DECISION_ID,
  language: "cs",
  court: "Nejvyšší soud",
  country: "CZE",
  decisionType: "rozsudek",
  documentAst,
  contentHash: "c".repeat(64),
  analysis: null,
  redactedAt: null,
  source: {
    descriptor: {
      license: "public-domain",
      attribution: null,
      allowsRedistribution: true,
      allowsDerivedAi: true,
    },
  },
  ...overrides,
});

const VALID_OUTPUT = {
  headings: [
    {
      id: "",
      label: "Odůvodnění",
      category: "reasoning",
      startAnchorId: "b2",
      endAnchorId: "b2",
      annotations: [],
    },
  ],
  holding: {
    text: "A limitation period runs from the day the claim could first be brought.",
    anchors: [{ startAnchorId: "b2", endAnchorId: "b2" }],
  },
  abstract: "The court dismissed the appeal.",
  topics: ["promlčení"],
};

const VALID_RECORD = {
  decisionId: DECISION_ID,
  fingerprint: "f".repeat(64),
  contentHash: "c".repeat(64),
  model: "some-provider/some-model",
  output: VALID_OUTPUT,
};

describe("resolveRowAnalysisInput", () => {
  test("resolves the same input the in-app run would compute", () => {
    const resolved = resolveRowAnalysisInput(row());

    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") {
      return;
    }
    expect(resolved.input.language).toBe("cs");
    // The anchored text, so the produced anchors name real paragraphs.
    expect(resolved.input.userMessage).toContain("[b1] Rozsudek");
    expect(resolved.input.userMessage).toContain("[b2] Soud dovolání zamítl.");
    // The Czech prompt, because the decision is Czech.
    expect(resolved.input.systemPrompt).toContain("právní analytik");
    expect(resolved.input.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("the fingerprint follows the text, so a re-parse invalidates it", () => {
    const first = resolveRowAnalysisInput(row());
    const renumbered = resolveRowAnalysisInput(
      row({
        documentAst: {
          version: 1,
          blocks: [
            paragraph("b7", "Rozsudek"),
            paragraph("b8", "Soud dovolání zamítl."),
          ],
        },
      }),
    );

    expect(first.status).toBe("ok");
    expect(renumbered.status).toBe("ok");
    if (first.status !== "ok" || renumbered.status !== "ok") {
      return;
    }
    expect(renumbered.input.fingerprint).not.toBe(first.input.fingerprint);
  });

  test("refuses a redacted decision: its text was erased on request", () => {
    expect(resolveRowAnalysisInput(row({ redactedAt: new Date() }))).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.redacted,
    });
  });

  test("refuses a source whose terms withhold derived AI use", () => {
    expect(
      resolveRowAnalysisInput(
        row({
          source: {
            descriptor: {
              license: "restricted",
              attribution: null,
              allowsRedistribution: false,
              allowsDerivedAi: false,
            },
          },
        }),
      ),
    ).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.derivedAiNotAllowed,
    });
  });

  test("refuses a decision with no source row: unknown terms are not permissive", () => {
    expect(resolveRowAnalysisInput(row({ source: null }))).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.derivedAiNotAllowed,
    });
  });

  // Under canonical corpus storage the parse lives in object storage, which
  // this database-only login cannot read. Said plainly, not as a crash.
  test("refuses a row whose parse is not in the column", () => {
    expect(resolveRowAnalysisInput(row({ documentAst: null }))).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.astUnavailable,
    });
    expect(
      resolveRowAnalysisInput(row({ documentAst: { version: 1, blocks: [] } })),
    ).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.astUnavailable,
    });
  });
});

describe("parseSubmissionRecord", () => {
  test("accepts a record shaped like the input script's output schema", () => {
    const parsed = parseSubmissionRecord(VALID_RECORD);
    expect(parsed.status).toBe("ok");
  });

  test("rejects a submitted significance layer by name", () => {
    const parsed = parseSubmissionRecord({
      ...VALID_RECORD,
      output: { ...VALID_OUTPUT, significance: "Widely followed." },
    });

    expect(parsed).toEqual({
      status: "rejected",
      decisionId: DECISION_ID,
      reason: ANALYSIS_REJECTION.significanceNotAccepted,
    });
  });

  test("rejects a record missing a document-fenced layer", () => {
    for (const missing of ["holding", "abstract", "topics"] as const) {
      const { [missing]: _absent, ...partial } = VALID_OUTPUT;
      expect(
        parseSubmissionRecord({ ...VALID_RECORD, output: partial }).status,
      ).toBe("rejected");
    }
  });

  test("rejects an over-long holding, and keeps the decision id in the report", () => {
    const parsed = parseSubmissionRecord({
      ...VALID_RECORD,
      output: {
        ...VALID_OUTPUT,
        holding: { ...VALID_OUTPUT.holding, text: "x".repeat(401) },
      },
    });

    expect(parsed).toEqual({
      status: "rejected",
      decisionId: DECISION_ID,
      reason: ANALYSIS_REJECTION.invalidOutput,
    });
  });

  test("keeps contentHash nullable, because the row's may be null", () => {
    expect(
      parseSubmissionRecord({ ...VALID_RECORD, contentHash: null }).status,
    ).toBe("ok");
  });
});

describe("parseSubmissionFile", () => {
  const recordsOf = (raw: string): unknown[] => {
    const parsed = parseSubmissionFile(raw);
    if (Result.isError(parsed)) {
      throw parsed.error;
    }
    return parsed.value;
  };

  test("reads one record or a list of them", () => {
    expect(recordsOf(JSON.stringify(VALID_RECORD))).toHaveLength(1);
    expect(
      recordsOf(JSON.stringify([VALID_RECORD, VALID_RECORD])),
    ).toHaveLength(2);
  });

  test("names a file that is not JSON instead of throwing", () => {
    const parsed = parseSubmissionFile("{not json");
    expect(Result.isError(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      expect(parsed.error.message).toContain("--input");
    }
  });
});

describe("run reporting", () => {
  test("every outcome reports one word an operator can act on", () => {
    expect(
      describeUpdateOutcome({
        kind: "unchanged",
        analysis: {
          version: 2,
          generatedAt: "2026-08-01T00:00:00.000Z",
          model: "m",
          inputFingerprint: "f".repeat(64),
          tree: [],
        },
      }),
    ).toBe("unchanged");
    expect(describeUpdateOutcome({ kind: "stale-fingerprint" })).toBe(
      "rejected:stale-fingerprint",
    );
    expect(describeUpdateOutcome({ kind: "stale-content-hash" })).toBe(
      "rejected:stale-content-hash",
    );
    expect(describeUpdateOutcome({ kind: "run-in-flight" })).toBe(
      "rejected:run-in-flight",
    );
    expect(describeUpdateOutcome({ kind: "claim-lost" })).toBe(
      "rejected:claim-lost",
    );
    expect(describeUpdateOutcome({ kind: "derived-ai-refused" })).toBe(
      "rejected:derived-ai-not-allowed",
    );
  });
});

describe("argument and environment handling", () => {
  test("reads ids one per line, ignoring blanks and comments", () => {
    expect(parseIdsFile("# batch one\n\na\n  b  \n")).toEqual(["a", "b"]);
  });

  test("reads a flag's value, and treats a following flag as no value", () => {
    expect(flagValue(["--limit", "20"], "limit")).toBe("20");
    expect(flagValue(["--limit", "--ids-only"], "limit")).toBeUndefined();
    expect(flagValue(["--ids-only"], "limit")).toBeUndefined();
    expect(hasFlag(["--ids-only"], "ids-only")).toBe(true);
  });

  test("falls back rather than accepting a nonsense count", () => {
    expect(positiveInteger("20", 100)).toBe(20);
    expect(positiveInteger("0", 100)).toBe(100);
    expect(positiveInteger("many", 100)).toBe(100);
    expect(nonNegativeInteger("0", 1)).toBe(0);
    expect(nonNegativeInteger("-1", 1)).toBe(1);
  });

  test("names the connection variable when it is missing", () => {
    const missing = readAnalysisDatabaseUrl({});
    expect(Result.isError(missing)).toBe(true);
    if (Result.isError(missing)) {
      expect(missing.error.message).toContain("CASE_LAW_ANALYSIS_DATABASE_URL");
    }

    const present = readAnalysisDatabaseUrl({
      CASE_LAW_ANALYSIS_DATABASE_URL: "postgres://x",
    });
    expect(Result.isOk(present)).toBe(true);
    if (Result.isOk(present)) {
      expect(present.value).toBe("postgres://x");
    }
  });
});
