import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  missingBodyReason,
  missingBodyRetryable,
  MISSING_BODY_REASON,
  hasDecisionText,
} from "@/features/case-law/components/case-viewer/decision-body-state.logic";

test("empty and whitespace-only text do not make a decision indexable", () => {
  for (const fulltext of [null, "", " \n\t", "\u00a0"]) {
    expect(hasDecisionText({ fulltext, documentAst: null })).toBe(false);
  }
  expect(hasDecisionText({ fulltext: "Judgment", documentAst: null })).toBe(
    true,
  );
});

test("AST text remains available when the fulltext fallback is absent", () => {
  const documentAst = {
    version: 1,
    source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
    metadata: {
      caseNumber: "1",
      ecli: null,
      court: "Court",
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        type: "paragraph",
        id: "p1",
        anchorId: "p1",
        plainText: "Judgment",
        inlines: [{ type: "text", text: "Judgment" }],
      },
    ],
  } satisfies DocumentAst;
  expect(hasDecisionText({ documentAst, fulltext: null })).toBe(true);
  expect(
    hasDecisionText({
      documentAst: { ...documentAst, blocks: [] },
      fulltext: null,
    }),
  ).toBe(false);
});

const state = (
  overrides: Partial<Parameters<typeof missingBodyReason>[0]>,
) => ({
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  ...overrides,
});

describe("missingBodyReason", () => {
  test("a failed object read is named as one", () => {
    expect(
      missingBodyReason(
        state({ documentPending: true, documentReadFailed: true }),
      ),
    ).toBe(MISSING_BODY_REASON.readFailed);
  });

  test("a failed read outranks every other flag", () => {
    // With the payload refused nothing else can tell a failed read from a
    // decision that never had a document, so the failure has to win.
    expect(
      missingBodyReason(
        state({
          documentPending: true,
          documentReadFailed: true,
          documentUnavailable: true,
        }),
      ),
    ).toBe(MISSING_BODY_REASON.readFailed);
  });

  test("a document nobody has fetched yet is still coming", () => {
    expect(missingBodyReason(state({ documentPending: true }))).toBe(
      MISSING_BODY_REASON.pending,
    );
  });

  test("a publisher that offers no text is terminal", () => {
    expect(missingBodyReason(state({ documentUnavailable: true }))).toBe(
      MISSING_BODY_REASON.unavailable,
    );
  });

  test("a record with nothing to fetch is its own reason", () => {
    expect(missingBodyReason(state({}))).toBe(MISSING_BODY_REASON.absent);
  });
});

describe("missingBodyRetryable", () => {
  test("asking again can still produce a failed or a queued read", () => {
    expect(missingBodyRetryable(MISSING_BODY_REASON.readFailed)).toBe(true);
    expect(missingBodyRetryable(MISSING_BODY_REASON.pending)).toBe(true);
  });

  test("nothing to ask for when the text was never offered", () => {
    expect(missingBodyRetryable(MISSING_BODY_REASON.unavailable)).toBe(false);
    expect(missingBodyRetryable(MISSING_BODY_REASON.absent)).toBe(false);
  });
});
