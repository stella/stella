import { describe, expect, test } from "bun:test";

import {
  decidePdfSigningPoll,
  parsePdfSigningDeadline,
  PDF_SIGNING_POLL_INTERVAL_MS,
  pdfSigningStartErrorCode,
  type PdfSigningSessionSnapshot,
} from "@/lib/pdf-signing.logic";

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

const openSession = (
  overrides: Partial<PdfSigningSessionSnapshot> = {},
): PdfSigningSessionSnapshot => ({
  closeReason: null,
  expiresAt: new Date(NOW + 60_000).toISOString(),
  finalizedVersionNumber: null,
  status: "open",
  ...overrides,
});

describe("pdf signing poll decisions", () => {
  test("keeps waiting at the poll cadence while the session is open", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 60_000,
        now: NOW,
        session: openSession(),
      }),
    ).toEqual({
      type: "waiting",
      deadline: NOW + 60_000,
      delayMs: PDF_SIGNING_POLL_INTERVAL_MS,
    });
  });

  test("extends the deadline when redemption replaces the handoff window", () => {
    // The handoff lives two minutes; the redeemed session lives ten, and the
    // browser learns that only from the session it polls.
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 30_000,
        now: NOW,
        session: openSession({
          expiresAt: new Date(NOW + 600_000).toISOString(),
        }),
      }),
    ).toEqual({
      type: "waiting",
      deadline: NOW + 600_000,
      delayMs: PDF_SIGNING_POLL_INTERVAL_MS,
    });
  });

  test("never sleeps past the deadline", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 500,
        now: NOW,
        session: openSession({ expiresAt: new Date(NOW + 500).toISOString() }),
      }),
    ).toEqual({ type: "waiting", deadline: NOW + 500, delayMs: 500 });
  });

  test("gives up on an open session whose window has closed", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW,
        now: NOW,
        session: openSession({ expiresAt: new Date(NOW).toISOString() }),
      }),
    ).toEqual({ type: "settled", outcome: { type: "expired" } });
  });

  test("settles on the version the desktop app produced", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 60_000,
        now: NOW,
        session: openSession({
          finalizedVersionNumber: 7,
          status: "finalized",
        }),
      }),
    ).toEqual({
      type: "settled",
      outcome: { type: "finalized", versionNumber: 7 },
    });
  });

  test("settles as finalized even when the signed version is gone", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 60_000,
        now: NOW,
        session: openSession({
          finalizedVersionNumber: null,
          status: "finalized",
        }),
      }),
    ).toEqual({
      type: "settled",
      outcome: { type: "finalized", versionNumber: null },
    });
  });

  test("carries the close reason a cancellation was given", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 60_000,
        now: NOW,
        session: openSession({
          closeReason: "certificate_rejected",
          status: "cancelled",
        }),
      }),
    ).toEqual({
      type: "settled",
      outcome: { type: "cancelled", closeReason: "certificate_rejected" },
    });
  });

  test("reports the server's own expiry verdict without waiting further", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 600_000,
        now: NOW,
        session: openSession({ status: "expired" }),
      }),
    ).toEqual({ type: "settled", outcome: { type: "expired" } });
  });
});

describe("pdf signing deadline parsing", () => {
  test("uses the timestamp the API reported", () => {
    expect(
      parsePdfSigningDeadline({
        expiresAt: new Date(NOW + 120_000).toISOString(),
        now: NOW,
      }),
    ).toBe(NOW + 120_000);
  });

  test("bounds the watch when the timestamp is unusable", () => {
    expect(
      parsePdfSigningDeadline({ expiresAt: "not-a-timestamp", now: NOW }),
    ).toBe(NOW + 120_000);
  });
});

describe("pdf signing start failures", () => {
  test("recognizes the refusals the browser explains itself", () => {
    expect(pdfSigningStartErrorCode("pdf_signing_not_a_pdf")).toBe(
      "pdf_signing_not_a_pdf",
    );
    expect(pdfSigningStartErrorCode("pdf_signing_encrypted")).toBe(
      "pdf_signing_encrypted",
    );
    expect(pdfSigningStartErrorCode("pdf_signing_too_large")).toBe(
      "pdf_signing_too_large",
    );
    expect(pdfSigningStartErrorCode("pdf_signing_not_a_file")).toBe(
      "pdf_signing_not_a_file",
    );
    expect(pdfSigningStartErrorCode("entity_read_only")).toBe(
      "entity_read_only",
    );
    expect(pdfSigningStartErrorCode("pdf_signing_certified_document")).toBe(
      "pdf_signing_certified_document",
    );
  });

  test("leaves every other failure to the generic message", () => {
    expect(pdfSigningStartErrorCode("internal_server_error")).toBeNull();
    expect(pdfSigningStartErrorCode(undefined)).toBeNull();
  });
});
