/**
 * Pure decisions behind signing a PDF in the desktop app: what a polled
 * signing session means for the waiting toast, and when the browser stops
 * polling it.
 */

import { panic } from "better-result";

import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

/** Poll cadence while the desktop app holds the signing dialog open. */
export const PDF_SIGNING_POLL_INTERVAL_MS = 2000;

/**
 * How long the browser keeps watching when a response carries an unusable
 * expiry. The server's own handoff and session TTLs are both shorter, so this
 * only bounds a malformed timestamp.
 */
const PDF_SIGNING_FALLBACK_WATCH_MS = 2 * 60 * 1000;

export type PdfSigningCloseReason =
  | "base_version_diverged"
  | "certificate_rejected"
  | "certificate_revoked"
  | "certified_document"
  | "digest_mismatch"
  | "expired"
  | "signature_invalid"
  | "signing_failed"
  | "stamp_overflow"
  | "stamp_unrenderable"
  | "unsupported_platform"
  | "user_cancelled"
  | "would_break_signatures";

/**
 * The signing session as the browser reads it. The API response is bound to
 * this shape at the call site, so a new status or close reason fails the build
 * here instead of falling through the toast as an unexplained cancellation.
 */
export type PdfSigningSessionSnapshot = {
  closeReason: PdfSigningCloseReason | null;
  expiresAt: string;
  finalizedVersionNumber: number | null;
  status: "cancelled" | "expired" | "finalized" | "open";
};

export type PdfSigningOutcome =
  | { type: "cancelled"; closeReason: PdfSigningCloseReason | null }
  | { type: "expired" }
  | { type: "finalized"; versionNumber: number | null };

export type PdfSigningPollDecision =
  | { type: "settled"; outcome: PdfSigningOutcome }
  | { type: "waiting"; deadline: number; delayMs: number };

export const parsePdfSigningDeadline = ({
  expiresAt,
  now,
}: {
  expiresAt: string;
  now: number;
}): number => {
  const parsed = new Date(expiresAt).getTime();
  return Number.isFinite(parsed) ? parsed : now + PDF_SIGNING_FALLBACK_WATCH_MS;
};

export const decidePdfSigningPoll = ({
  deadline,
  now,
  session,
}: {
  deadline: number;
  now: number;
  session: PdfSigningSessionSnapshot;
}): PdfSigningPollDecision => {
  switch (session.status) {
    case "cancelled": {
      return {
        type: "settled",
        outcome: { type: "cancelled", closeReason: session.closeReason },
      };
    }
    case "expired": {
      return { type: "settled", outcome: { type: "expired" } };
    }
    case "finalized": {
      return {
        type: "settled",
        outcome: {
          type: "finalized",
          versionNumber: session.finalizedVersionNumber,
        },
      };
    }
    case "open": {
      // Redeeming the handoff replaces its two-minute window with the signing
      // session's own TTL, so the deadline only ever moves outward.
      const extended = Math.max(
        deadline,
        parsePdfSigningDeadline({ expiresAt: session.expiresAt, now }),
      );
      if (now >= extended) {
        return { type: "settled", outcome: { type: "expired" } };
      }
      return {
        type: "waiting",
        deadline: extended,
        delayMs: Math.min(PDF_SIGNING_POLL_INTERVAL_MS, extended - now),
      };
    }
    default: {
      session.status satisfies never;
      return panic(
        `Unhandled signing session status: ${String(session.status)}`,
      );
    }
  }
};

/**
 * What a finalized signature makes stale. The signed PDF is a new current
 * version, so the version history is not enough: the entity detail decides
 * which file field the open viewer shows. Realtime refreshes both too; this
 * covers a client whose socket is asleep.
 */
export const pdfSigningFinalizedQueryKeys = ({
  entityId,
  workspaceId,
}: {
  entityId: string;
  workspaceId: string;
}) => [
  entitiesKeys.detail(workspaceId, entityId),
  entitiesKeys.versions(workspaceId, entityId),
];

/**
 * Narrow the API's refusal to the codes the browser explains in its own
 * words. Anything else (auth, a missing document, a server fault) keeps the
 * generic failure message.
 */
export const pdfSigningStartErrorCode = (code: string | undefined) => {
  if (code === undefined) {
    return null;
  }
  switch (code) {
    case "entity_read_only":
    case "pdf_signing_base_version_changed":
    case "pdf_signing_certified_document":
    case "pdf_signing_encrypted":
    case "pdf_signing_in_progress":
    case "pdf_signing_not_a_file":
    case "pdf_signing_not_a_pdf":
    case "pdf_signing_stamp_off_page":
    case "pdf_signing_stamp_page_not_found":
    case "pdf_signing_stamp_time_zone":
    case "pdf_signing_stamp_too_large":
    case "pdf_signing_stamp_too_small":
    case "pdf_signing_stamp_unrenderable":
    case "pdf_signing_too_large": {
      return code;
    }
    default: {
      return null;
    }
  }
};

export type PdfSigningStartErrorCode = NonNullable<
  ReturnType<typeof pdfSigningStartErrorCode>
>;
