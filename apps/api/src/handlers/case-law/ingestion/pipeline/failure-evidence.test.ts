import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@stll/case-law-ingestion-core/decision-text";
import type { IngestionResult } from "@stll/case-law-ingestion-core/ingestion-types";
import { plainTextIngestionResult } from "@stll/case-law-ingestion-core/plain-text-assembly";

import {
  captureFailureEvidence,
  ingestionFailureRecordIdentity,
} from "@/api/handlers/case-law/ingestion/pipeline/failure-evidence";

const rawInput = {
  caseNumber: "No. 24-100",
  country: "USA",
  language: "en",
  court: "Supreme Court of the United States",
  courtId: "scotus",
  metadata: { b: "second", a: "first" },
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash: "synthetic-input",
  sourceRaw: "publisher body",
  documentAst: {},
};
const input = plainTextIngestionResult(rawInput);

test("captured-input identity is deterministic and separate from a publisher post", () => {
  const capture = (decision: IngestionResult) =>
    captureFailureEvidence({
      record: { type: "decision", decision },
      observation: { order: 1n, observedAt: new Date("2026-01-01T00:00:00Z") },
    }).unwrap();
  const evidence = capture(input);
  const equivalent = capture(
    plainTextIngestionResult({
      ...rawInput,
      metadata: { a: "first", b: "second" },
    }),
  );
  expect(equivalent).toEqual(evidence);
  const later = captureFailureEvidence({
    record: { type: "decision", decision: input },
    observation: { order: 2n, observedAt: new Date("2026-01-02T00:00:00Z") },
  }).unwrap();
  expect(later.payloadHash).toBe(evidence.payloadHash);
  expect(later.observationOrder).toBe(2n);
  const fallback = ingestionFailureRecordIdentity({
    sourceDocumentId: undefined,
    replayEvidence: evidence,
  });
  expect(fallback).toEqual({
    recordIdentity: `input:${evidence.payloadHash}`,
    identityKind: "captured-input",
  });
  expect(
    ingestionFailureRecordIdentity({
      sourceDocumentId: undefined,
      replayEvidence: equivalent,
    }),
  ).toEqual(fallback);
  for (const changed of [
    plainTextIngestionResult({ ...rawInput, sourceRaw: "different body" }),
    plainTextIngestionResult({ ...rawInput, caseNumber: "No. 24-101" }),
    plainTextIngestionResult({
      ...rawInput,
      sourceRawBytes: Uint8Array.from([0, 255]),
    }),
    plainTextIngestionResult({
      ...rawInput,
      metadata: { a: "different publisher evidence" },
    }),
  ]) {
    expect(
      ingestionFailureRecordIdentity({
        sourceDocumentId: undefined,
        replayEvidence: capture(changed),
      }),
    ).not.toEqual(fallback);
  }
  expect(
    ingestionFailureRecordIdentity({
      sourceDocumentId: "post-42",
      replayEvidence: evidence,
    }),
  ).toEqual({
    recordIdentity: "post-42",
    identityKind: "source-document",
  });
  expect(
    ingestionFailureRecordIdentity({
      sourceDocumentId: "post-42",
      recordIdentity: "import:42",
      replayEvidence: evidence,
    }),
  ).toEqual({
    recordIdentity: "import:42",
    identityKind: "provided-record",
  });
});

test("invalid identities and uncaptured anonymous inputs cannot certify a park", () => {
  for (const sourceDocumentId of ["", "bad\u0000id", "x".repeat(257)]) {
    expect(
      ingestionFailureRecordIdentity({ sourceDocumentId }),
    ).toBeUndefined();
  }
  expect(
    ingestionFailureRecordIdentity({ sourceDocumentId: undefined }),
  ).toBeUndefined();
  const invalidPost = "x".repeat(257);
  const evidence = captureFailureEvidence({
    record: {
      type: "decision",
      decision: { ...input, sourceDocumentId: invalidPost },
    },
    observation: { order: 1n, observedAt: new Date("2026-01-01T00:00:00Z") },
  }).unwrap();
  expect(evidence.sourceDocumentId).toBeNull();
  expect(evidence.payload).toContain(invalidPost);
  expect(
    ingestionFailureRecordIdentity({
      sourceDocumentId: invalidPost,
      replayEvidence: evidence,
    }),
  ).toEqual({
    recordIdentity: `input:${evidence.payloadHash}`,
    identityKind: "captured-input",
  });
});

test.each([undefined, "publisher-post-42"])(
  "classifies a failed label with publisher identity %s without mistaking a quarantine key for a post",
  (sourceDocumentId) => {
    const failed = plainTextIngestionResult({
      ...input,
      sourceDocumentId,
      caseNumber: "{\\rtf1 invalid label}",
    });
    expect(failed.plainTextOutcome.type).toBe("item_build_failed");
    const evidence = captureFailureEvidence({
      record: { type: "decision", decision: failed },
      observation: { order: 1n, observedAt: new Date("2026-01-01T00:00:00Z") },
    }).unwrap();
    const storedIdentity =
      failed.sourceDocumentId ??
      panic("Rejected labels retain a source identity");
    const identity = ingestionFailureRecordIdentity({
      sourceDocumentId: storedIdentity,
      replayEvidence: evidence,
    });
    expect(evidence.sourceDocumentId).toBe(storedIdentity);
    expect(identity).toEqual(
      sourceDocumentId === undefined
        ? {
            recordIdentity: `input:${evidence.payloadHash}`,
            identityKind: "captured-input",
          }
        : { recordIdentity: sourceDocumentId, identityKind: "source-document" },
    );
  },
);
