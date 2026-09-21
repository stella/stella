import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { entities } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { readEntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { closePdfSigningSession } from "@/api/lib/pdf-signing/close-session";
import {
  pdfSigningFileDescriptor,
  readVersionPdfSigningTarget,
} from "@/api/lib/pdf-signing/pdf-target";
import type { AuthorizedPdfSigningSession } from "@/api/lib/pdf-signing/sessions";

type LoadPdfSigningBaseBytesOptions = {
  recordAuditEvent: AuditRecorder;
  session: AuthorizedPdfSigningSession;
};

/**
 * The exact bytes both phases sign.
 *
 * The divergence check runs here rather than only at finalize: both phases
 * must hash the same base, so an exchange whose document moved on is closed
 * at the first call that notices, with the reason the browser shows.
 */
export const loadPdfSigningBaseBytes = async ({
  recordAuditEvent,
  session,
}: LoadPdfSigningBaseBytesOptions): Promise<
  Result<Uint8Array, HandlerError>
> => {
  const resolved = await session.safeDb(async (tx) => {
    const entityRows = await tx
      .select({ currentVersionId: entities.currentVersionId })
      .from(entities)
      .where(eq(entities.id, session.entityId))
      .limit(1);

    if (entityRows.at(0)?.currentVersionId !== session.baseVersionId) {
      return { status: "diverged" } as const;
    }

    const target = await readVersionPdfSigningTarget({
      entityVersionId: session.baseVersionId,
      propertyId: session.propertyId,
      tx,
      workspaceId: session.workspaceId,
    });

    if (!target || target.status === "rejected") {
      return { status: "diverged" } as const;
    }

    return { status: "found", fileContent: target.fileContent } as const;
  });

  if (Result.isError(resolved)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to read the document to sign.",
        cause: resolved.error,
      }),
    );
  }

  if (resolved.value.status === "diverged") {
    const closed = await closePdfSigningSession({
      closeReason: "base_version_diverged",
      recordAuditEvent,
      safeDb: session.safeDb,
      sessionId: session.sessionId,
    });
    if (Result.isError(closed)) {
      return closed;
    }
    return Result.err(
      new HandlerError({
        status: 409,
        code: "pdf_signing_base_version_diverged",
        message:
          "This document changed in stella while it was being signed. Start signing again.",
      }),
    );
  }

  const bytes = await readEntityVersionFile(
    pdfSigningFileDescriptor({
      entityId: session.entityId,
      entityVersionId: session.baseVersionId,
      fileContent: resolved.value.fileContent,
      propertyId: session.propertyId,
      workspaceId: session.workspaceId,
    }),
    session.organizationId,
  );
  if (Result.isError(bytes)) {
    return bytes;
  }

  return Result.ok(new Uint8Array(bytes.value));
};
