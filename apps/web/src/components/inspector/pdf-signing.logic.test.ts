import { describe, expect, test } from "bun:test";

import { DESKTOP_HANDOFF_FAILURE } from "@stll/api-contract/desktop-handoff";

import {
  decidePdfSigningPoll,
  parsePdfSigningDeadline,
  PDF_SIGNING_POLL_INTERVAL_MS,
  pdfSigningFinalizedQueryKeys,
  pdfSigningStartErrorCode,
  type PdfSigningSessionSnapshot,
  resolvePdfSignTarget,
} from "@/components/inspector/pdf-signing.logic";

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
  for (const closeReason of Object.values(DESKTOP_HANDOFF_FAILURE)) {
    test(`${closeReason} settles before the handoff deadline`, () => {
      expect(
        decidePdfSigningPoll({
          deadline: NOW + 120_000,
          handoffDeadline: NOW,
          now: NOW,
          session: openSession({ status: "cancelled", closeReason }),
        }),
      ).toEqual({
        type: "settled",
        outcome: { type: "cancelled", closeReason },
      });
    });
  }

  test("keeps waiting at the poll cadence while the session is open", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 60_000,
        handoffDeadline: NOW,
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
        handoffDeadline: NOW,
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
        handoffDeadline: NOW,
        now: NOW,
        session: openSession({ expiresAt: new Date(NOW + 500).toISOString() }),
      }),
    ).toEqual({ type: "waiting", deadline: NOW + 500, delayMs: 500 });
  });

  test("gives up on an open session whose window has closed", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW,
        handoffDeadline: NOW,
        now: NOW,
        session: openSession({ expiresAt: new Date(NOW).toISOString() }),
      }),
    ).toEqual({
      type: "settled",
      outcome: { type: "expired", stage: "handoff" },
    });
  });

  test("an unredeemed handoff the server expired was never picked up", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 120_000,
        handoffDeadline: NOW + 120_000,
        now: NOW + 120_000,
        session: openSession({
          expiresAt: new Date(NOW + 120_000).toISOString(),
          status: "expired",
        }),
      }),
    ).toEqual({
      type: "settled",
      outcome: { type: "expired", stage: "handoff" },
    });
  });

  test("a redeemed session that ran out was picked up by the desktop app", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 120_000,
        handoffDeadline: NOW + 120_000,
        now: NOW + 600_000,
        session: openSession({
          expiresAt: new Date(NOW + 600_000).toISOString(),
        }),
      }),
    ).toEqual({
      type: "settled",
      outcome: { type: "expired", stage: "session" },
    });
  });

  test("settles on the version the desktop app produced", () => {
    expect(
      decidePdfSigningPoll({
        deadline: NOW + 60_000,
        handoffDeadline: NOW,
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
        handoffDeadline: NOW,
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
        handoffDeadline: NOW,
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
        handoffDeadline: NOW,
        now: NOW,
        session: openSession({ status: "expired" }),
      }),
    ).toEqual({
      type: "settled",
      outcome: { type: "expired", stage: "session" },
    });
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
    expect(pdfSigningStartErrorCode("pdf_signing_in_progress")).toBe(
      "pdf_signing_in_progress",
    );
    expect(pdfSigningStartErrorCode("pdf_signing_base_version_changed")).toBe(
      "pdf_signing_base_version_changed",
    );
    expect(pdfSigningStartErrorCode("pdf_signing_stamp_off_page")).toBe(
      "pdf_signing_stamp_off_page",
    );
    expect(pdfSigningStartErrorCode("pdf_signing_stamp_unrenderable")).toBe(
      "pdf_signing_stamp_unrenderable",
    );
  });

  test("leaves every other failure to the generic message", () => {
    expect(pdfSigningStartErrorCode("internal_server_error")).toBeNull();
    expect(pdfSigningStartErrorCode(undefined)).toBeNull();
  });
});

describe("refreshing after a signature lands", () => {
  test("refreshes the entity the viewer reads its current file from", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { entitiesKeys } =
      await import("@/lib/workspaces/queries/entities.logic");
    const { entityVersionsKeys } =
      await import("@/lib/workspaces/queries/entity-versions");
    const queryClient = new QueryClient();
    const target = { entityId: "entity-1", workspaceId: "workspace-1" };
    const detail = entitiesKeys.detail(target.workspaceId, target.entityId);
    const versions = entityVersionsKeys.all(target);
    const unrelated = entitiesKeys.detail(target.workspaceId, "entity-2");
    for (const queryKey of [detail, versions, unrelated]) {
      queryClient.setQueryData(queryKey, { cached: true });
    }

    for (const queryKey of pdfSigningFinalizedQueryKeys(target)) {
      await queryClient.invalidateQueries({ queryKey });
    }

    expect(queryClient.getQueryState(detail)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(versions)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });
});

describe("resolvePdfSignTarget", () => {
  const signable = {
    canUpdateEntity: true,
    entityId: "entity-1",
    file: {
      fieldId: "field-1",
      mimeType: "application/pdf",
      propertyId: "property-1",
    },
    isCurrentVersion: true,
    workspaceId: "workspace-1",
  };

  test("targets the current PDF of an entity the user can update", () => {
    expect(resolvePdfSignTarget(signable)).toEqual({
      entityId: "entity-1",
      fieldId: "field-1",
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });
  });

  test.each([
    ["without update permission", { canUpdateEntity: false }],
    ["on an older version", { isCurrentVersion: false }],
    ["without a file", { file: null }],
    [
      "for a file that is not a PDF",
      { file: { ...signable.file, mimeType: "application/msword" } },
    ],
    [
      "for a file without a property",
      { file: { ...signable.file, propertyId: undefined } },
    ],
  ])("offers no signing %s", (_label, override) => {
    expect(resolvePdfSignTarget({ ...signable, ...override })).toBeNull();
  });
});
