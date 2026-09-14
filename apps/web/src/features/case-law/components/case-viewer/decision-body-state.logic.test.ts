import { describe, expect, test } from "bun:test";

import {
  missingBodyReason,
  missingBodyRetryable,
  MISSING_BODY_REASON,
} from "@/features/case-law/components/case-viewer/decision-body-state.logic";

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
