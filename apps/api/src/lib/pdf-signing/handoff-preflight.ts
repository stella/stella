/**
 * What is checked against the stored PDF when signing is requested, before
 * the desktop opens: a certification that forbids changes, and where a
 * visible stamp goes. Reads the bytes outside any transaction; a target
 * that is missing or not signable is left for the caller's own check.
 */

import { PDF } from "@libpdf/core";
import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { PdfSigningStamp } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readEntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readDocMdpPermission } from "@/api/lib/pdf-signing/doc-mdp";
import {
  pdfSigningFileDescriptor,
  readCurrentPdfSigningTarget,
} from "@/api/lib/pdf-signing/pdf-target";
import { sanitizeSigningText } from "@/api/lib/pdf-signing/signing-text";
import { placeStamp } from "@/api/lib/pdf-signing/stamp";
import type {
  StampPlacementRejection,
  ViewerBox,
} from "@/api/lib/pdf-signing/stamp";
import { loadStampFont } from "@/api/lib/pdf-signing/stamp-font";
import {
  drawableLabels,
  stampTextCheck,
} from "@/api/lib/pdf-signing/stamp-text";

/** A stamp label is a short phrase ("Digitally signed by", "Date"). */
export const STAMP_LABEL_MAX_LENGTH = 64;

/** What the browser sends for a visible stamp. */
export type StampRequest = {
  box: ViewerBox;
  direction: "ltr" | "rtl";
  labels: {
    date: string;
    location: string;
    reason: string;
    signedBy: string;
  };
  pageIndex: number;
  timeZone: string;
};

const STAMP_REJECTION_MESSAGES = {
  off_page: "The stamp must lie on the page.",
  page_not_found: "The stamp's page is not in this document.",
  too_large: "The stamp is too large.",
  too_small: "The stamp is too small to read.",
} as const satisfies Record<StampPlacementRejection, string>;

const stampRejected = (
  code: string,
  message: string,
): Result<never, HandlerError> =>
  Result.err(
    new HandlerError({
      status: 422,
      code: `pdf_signing_stamp_${code}`,
      message,
    }),
  );

// Formatting throws a RangeError for anything that is not an IANA zone.
const isTimeZone = (timeZone: string) =>
  Result.isOk(
    Result.try(() => new Intl.DateTimeFormat("en", { timeZone }).format(0)),
  );

const label = (value: string) =>
  sanitizeSigningText(value, STAMP_LABEL_MAX_LENGTH) ?? "";

/** The stamp to store, or the refusal to answer with. */
export const resolveStampRequest = (
  pdf: PDF,
  request: StampRequest,
): Result<PdfSigningStamp, HandlerError> => {
  if (!isTimeZone(request.timeZone)) {
    return stampRejected("time_zone", "The stamp's time zone is not known.");
  }
  const placed = placeStamp({
    box: request.box,
    pageIndex: request.pageIndex,
    pdf,
  });
  if (placed.status === "rejected") {
    return stampRejected(
      placed.reason,
      STAMP_REJECTION_MESSAGES[placed.reason],
    );
  }
  return Result.ok({
    direction: request.direction,
    labels: {
      date: label(request.labels.date),
      location: label(request.labels.location),
      reason: label(request.labels.reason),
      signedBy: label(request.labels.signedBy),
    },
    pageIndex: placed.pageIndex,
    rect: placed.rect,
    rotation: placed.rotation,
    timeZone: request.timeZone,
  });
};

export type PreflightedPdfSigning = {
  /**
   * The version whose bytes were checked, or `null` when the target was
   * missing or not signable (the caller's own check reports that). The
   * exchange may only be opened on this version.
   */
  baseVersionId: SafeId<"entityVersion"> | null;
  /** The stamp to store; `null` for an invisible signature. */
  stamp: PdfSigningStamp | null;
};

const UNCHECKED: PreflightedPdfSigning = { baseVersionId: null, stamp: null };

/**
 * What the stamp will say, made drawable: labels in the signer's language
 * or, when that cannot be drawn, English; a reason or location that cannot
 * be drawn refuses the visible stamp. See `stamp-text.ts`.
 */
export const drawableStamp = async ({
  location,
  reason,
  stamp,
}: {
  location: string | null;
  reason: string | null;
  stamp: PdfSigningStamp;
}): Promise<Result<PdfSigningStamp, HandlerError>> => {
  const check = stampTextCheck(await loadStampFont());
  const values = [reason, location].filter((value) => value !== null);
  if (!values.every((value) => check.canDraw(value))) {
    return stampRejected(
      "unrenderable",
      "The reason or location cannot be shown in a visible stamp. Change the text or sign invisibly.",
    );
  }
  return Result.ok(drawableLabels(stamp, check));
};

/**
 * Refuse a certified document, place the stamp, and name the version both
 * were checked against.
 */
export const preflightPdfSigning = async ({
  entityId,
  location,
  organizationId,
  propertyId,
  reason,
  safeDb,
  stamp,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  /** Sanitized; drawn on the stamp when there is one. */
  location: string | null;
  organizationId: SafeId<"organization">;
  propertyId: SafeId<"property">;
  reason: string | null;
  safeDb: SafeDb;
  stamp: StampRequest | undefined;
  workspaceId: SafeId<"workspace">;
}): Promise<Result<PreflightedPdfSigning, HandlerError>> => {
  const current = await safeDb(
    async (tx) =>
      await readCurrentPdfSigningTarget({
        entityId,
        propertyId,
        tx,
        workspaceId,
      }),
  );
  if (Result.isError(current)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to read the document to sign.",
        cause: current.error,
      }),
    );
  }
  if (!current.value || current.value.target.status !== "signable") {
    return Result.ok(UNCHECKED);
  }
  const { baseVersionId } = current.value;
  const bytes = await readEntityVersionFile(
    pdfSigningFileDescriptor({
      entityId,
      entityVersionId: current.value.baseVersionId,
      fileContent: current.value.target.fileContent,
      propertyId,
      workspaceId,
    }),
    organizationId,
  );
  if (Result.isError(bytes)) {
    return Result.err(bytes.error);
  }

  const source = new Uint8Array(bytes.value);
  const loaded = await Result.tryPromise(async () => await PDF.load(source));
  if (Result.isError(loaded)) {
    // Unreadable bytes are phase 1's to report, with their own reason; a
    // stamp cannot be placed on them, so that request is refused here.
    return stamp === undefined
      ? Result.ok({ baseVersionId, stamp: null })
      : stampRejected(
          "unreadable",
          "This PDF could not be read to place a stamp.",
        );
  }
  const pdf = loaded.value;

  if (readDocMdpPermission({ pdf, source }) === 1) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: "pdf_signing_certified_document",
        message:
          "This PDF is certified and its certification does not allow further signatures.",
      }),
    );
  }
  if (stamp === undefined) {
    return Result.ok({ baseVersionId, stamp: null });
  }
  const placed = resolveStampRequest(pdf, stamp);
  if (Result.isError(placed)) {
    return Result.err(placed.error);
  }
  const drawable = await drawableStamp({
    location,
    reason,
    stamp: placed.value,
  });
  return Result.isError(drawable)
    ? Result.err(drawable.error)
    : Result.ok({ baseVersionId, stamp: drawable.value });
};
