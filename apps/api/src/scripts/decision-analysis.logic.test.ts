/**
 * What the three decision-analysis scripts refuse, and what they accept.
 *
 * The scripts run under an operator against the live corpus, so every
 * refusal is exercised here instead: a redacted row, a source whose terms
 * withhold derived AI use, a decision with no parse anywhere,
 * and a submission carrying the graph-fenced layer it may not write.
 */

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { parseUsableDocumentAst } from "@stll/legal-ast/document-ast";

import { toSafeId } from "@/api/lib/branded-types";

import {
  ANALYSIS_REJECTION,
  courtFilter,
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
  summariseOutcomes,
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
  astS3Key: null,
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
  /** The parse the corpus reader hands back for this row's own column. */
  const resolveFromColumn = async (
    overrides: Partial<DecisionAnalysisRow> = {},
  ) => {
    const subject = row(overrides);
    return await resolveRowAnalysisInput({
      readAst: async () => parseUsableDocumentAst(subject.documentAst),
      row: subject,
    });
  };

  /** A reader that counts its calls, standing in for the object store. */
  const countingReader = () => {
    const reader = {
      reads: 0,
      readAst: async () => {
        reader.reads += 1;
        return parseUsableDocumentAst(documentAst);
      },
    };
    return reader;
  };

  test("resolves the same input the in-app run would compute", async () => {
    const resolved = await resolveFromColumn();

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

  test("the fingerprint follows the text, so a re-parse invalidates it", async () => {
    const first = await resolveFromColumn();
    const renumbered = await resolveFromColumn({
      documentAst: {
        version: 1,
        blocks: [
          paragraph("b7", "Rozsudek"),
          paragraph("b8", "Soud dovolání zamítl."),
        ],
      },
    });

    expect(first.status).toBe("ok");
    expect(renumbered.status).toBe("ok");
    if (first.status !== "ok" || renumbered.status !== "ok") {
      return;
    }
    expect(renumbered.input.fingerprint).not.toBe(first.input.fingerprint);
  });

  // A trimmed row is the normal case under canonical corpus storage: the
  // parse arrives from the object, and the decision is analysable.
  test("takes the parse the corpus reader resolved, not the row's column", async () => {
    const resolved = await resolveRowAnalysisInput({
      readAst: async () => parseUsableDocumentAst(documentAst),
      row: row({ documentAst: null, astS3Key: "cz/ns/abc.zst" }),
    });

    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") {
      return;
    }
    expect(resolved.input.userMessage).toContain("[b1] Rozsudek");
  });

  test("refuses a redacted decision: its text was erased on request", async () => {
    expect(await resolveFromColumn({ redactedAt: new Date() })).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.redacted,
    });
  });

  test("refuses a source whose terms withhold derived AI use", async () => {
    expect(
      await resolveFromColumn({
        source: {
          descriptor: {
            license: "restricted",
            attribution: null,
            allowsRedistribution: false,
            allowsDerivedAi: false,
          },
        },
      }),
    ).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.derivedAiNotAllowed,
    });
  });

  test("refuses a decision with no source row: unknown terms are not permissive", async () => {
    expect(await resolveFromColumn({ source: null })).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.derivedAiNotAllowed,
    });
  });

  // No parse in the column and none in the object either: there is no text
  // to analyse anywhere, which is what the reason says.
  test("refuses a row with no parse anywhere", async () => {
    expect(
      await resolveRowAnalysisInput({
        readAst: async () => null,
        row: row({ documentAst: null }),
      }),
    ).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.astUnavailable,
    });
    expect(
      await resolveFromColumn({ documentAst: { version: 1, blocks: [] } }),
    ).toEqual({
      status: "rejected",
      reason: ANALYSIS_REJECTION.astUnavailable,
    });
  });

  // A language with no prompt of its own is refused, not analysed under
  // another language's prompt: the input would describe the wrong analysis.
  // The refusal is decided from the row, so it never fetches the parse.
  test("refuses a decision in a language with no analysis prompt, without reading its parse", async () => {
    for (const language of ["fr", "hu", "", "CS", "constructor"]) {
      const reader = countingReader();
      expect(
        await resolveRowAnalysisInput({
          readAst: reader.readAst,
          row: row({ language }),
        }),
      ).toEqual({
        status: "rejected",
        reason: ANALYSIS_REJECTION.unsupportedLanguage,
      });
      expect(reader.reads).toBe(0);
    }
  });

  test("reads the parse once for a decision the row admits", async () => {
    const reader = countingReader();
    const resolved = await resolveRowAnalysisInput({
      readAst: reader.readAst,
      row: row(),
    });

    expect(resolved.status).toBe("ok");
    expect(reader.reads).toBe(1);
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

describe("summariseOutcomes", () => {
  test("counts each distinct outcome once, in a stable order", () => {
    expect(
      summariseOutcomes([
        "saved",
        "rejected:ast-unavailable",
        "saved",
        "unchanged",
        "rejected:ast-unavailable",
      ]),
    ).toEqual(["rejected:ast-unavailable: 2", "saved: 2", "unchanged: 1"]);
  });

  test("says nothing about a run that produced nothing", () => {
    expect(summariseOutcomes([])).toEqual([]);
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

  test("collects every --court, in order and without repeats", () => {
    expect(courtFilter(["--limit", "5"]).unwrap()).toBeUndefined();
    expect(
      courtFilter([
        "--court",
        "Nejvyšší soud",
        "--ids-only",
        "--court",
        "Ústavní soud",
        "--court",
        "Nejvyšší soud",
      ]).unwrap(),
    ).toEqual(["Nejvyšší soud", "Ústavní soud"]);
  });

  test("refuses a --court without a usable name instead of widening the run", () => {
    for (const argv of [
      ["--court"],
      ["--court", "--ids-only"],
      ["--court", "  "],
      ["--court", "x".repeat(513)],
      ["--court", "Nejvyšší soud", "--court"],
    ]) {
      const parsed = courtFilter(argv);
      expect(Result.isError(parsed)).toBe(true);
      if (Result.isError(parsed)) {
        expect(parsed.error.message).toContain("--court needs a court name");
      }
    }
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
