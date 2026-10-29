import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { decisionTextStateSchema } from "@stll/api-contract/case-law-fulltext-state";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import {
  failedDecisionText,
  FULLTEXT_RECOVERY_LIMITS,
  pendingDecisionText,
  textFailureFromObservation,
  verifiedDecisionText,
} from "./fulltext-state";

const now = new Date("2026-10-28T12:00:00.000Z");
const astWith = (blocks: Block[]) =>
  ({
    version: 1,
    source: {
      system: "text-proof-fixture",
      documentId: "synthetic",
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: "Fixture",
      ecli: null,
      court: "Court",
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks,
  }) satisfies DocumentAst;
const paragraph = (text: string) =>
  ({
    type: "paragraph",
    id: "p1",
    anchorId: "p1",
    plainText: text,
    inlines: [{ type: "text", text }],
  }) satisfies Block;

describe("full-text proof requires actual reader-visible words", () => {
  test.each(["", " ", "\n\t", "\u00a0", "\u200b\ufeff\u2060"])(
    "empty visible text never produces a proof: %j",
    (text) => {
      for (const ast of [null, {}, astWith([]), astWith([paragraph(text)])]) {
        expect(
          verifiedDecisionText({
            payload: { text, ast, sections: null },
            now,
            caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            storage: "postgres",
          }),
        ).toBeNull();
      }
    },
  );

  test("metadata headers and images cannot stand in for decision text", () => {
    const hidden = astWith([
      { ...paragraph("5 As 140/2014"), role: "case-number" },
      {
        type: "image",
        id: "image",
        anchorId: "image",
        plainText: "A scan",
        src: "https://example.com/scan.png",
      },
    ]);
    expect(
      verifiedDecisionText({
        payload: { text: null, ast: hidden, sections: null },
        now,
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        storage: "corpus",
      }),
    ).toBeNull();
  });

  test.each(["postgres", "corpus"] as const)(
    "a visible AST or retained fulltext proves actual content in %s",
    (storage) => {
      const visible = astWith([
        paragraph("The court returns the case to its panel."),
      ]);
      for (const payload of [
        { text: null, ast: visible, sections: null },
        {
          text: "The court returns the case to its panel.",
          ast: {},
          sections: null,
        },
      ]) {
        const proof = verifiedDecisionText({
          payload,
          now,
          caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          storage,
        });
        expect(proof).toMatchObject({
          status: "stored",
          storage,
          verifiedAt: now.toISOString(),
        });
        expect(v.safeParse(decisionTextStateSchema, proof).success).toBe(true);
      }
    },
  );

  test("hashes are tied to the complete verified payload", () => {
    const first = verifiedDecisionText({
      payload: { text: "First decision", ast: {}, sections: null },
      now,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      storage: "corpus",
    });
    const second = verifiedDecisionText({
      payload: { text: "Second decision", ast: {}, sections: null },
      now,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      storage: "corpus",
    });
    expect(first?.contentHash).not.toBe(second?.contentHash);
  });
});

describe("full-text recovery cannot confuse failure with publisher absence", () => {
  test.each([404, 410, 429, 500, 503])(
    "an HTTP %i is a fetch failure",
    (status) => {
      expect(
        textFailureFromObservation({
          readOutcome: {
            type: "unavailable",
            scope: "document",
            consecutiveCycles: 1,
            cause: { kind: "status", status },
          },
        }),
      ).toEqual({ kind: "http", status });
    },
  );
  test("an absent endpoint is not evidence the publisher's record has no text", () => {
    expect(
      textFailureFromObservation({
        readOutcome: { type: "absent", evidence: "http-404" },
      }),
    ).toEqual({ kind: "http", status: 404 });
    expect(
      textFailureFromObservation({
        readOutcome: {
          type: "unavailable",
          scope: "part",
          consecutiveCycles: 1,
          cause: { kind: "status", status: 500 },
        },
      }),
    ).toBeNull();
  });
  test("attempts retain a bounded durable retry time", () => {
    let previous = now.getTime();
    for (const attemptCount of [1, 2, 4, 100]) {
      const state = failedDecisionText({
        now,
        attemptCount,
        cause: { kind: "parser_refusal", code: "empty_ast" },
        retryFloorMs: FULLTEXT_RECOVERY_LIMITS.INITIAL_RETRY_MS,
      });
      expect(v.safeParse(decisionTextStateSchema, state).success).toBe(true);
      const due = new Date(state.nextAttemptAt).getTime();
      expect(due).toBeGreaterThanOrEqual(previous);
      expect(due - now.getTime()).toBeLessThanOrEqual(
        FULLTEXT_RECOVERY_LIMITS.MAX_RETRY_MS,
      );
      previous = due;
    }
    expect(
      v.safeParse(
        decisionTextStateSchema,
        pendingDecisionText({
          now,
          attemptCount: 0,
          lastAttemptAt: null,
          delayMs: 0,
        }),
      ).success,
    ).toBe(true);
  });
});
