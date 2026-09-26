import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { readEntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { certificationForbidsChanges } from "@/api/lib/pdf-signing/doc-mdp";
import type { PdfSigningTargetRejection } from "@/api/lib/pdf-signing/pdf-target";
import {
  pdfSigningFileDescriptor,
  readCurrentPdfSigningTarget,
} from "@/api/lib/pdf-signing/pdf-target";
import {
  computePdfSigningHandoffExpiresAt,
  createPdfSigningToken,
  hashPdfSigningToken,
  openPdfSigningSession,
} from "@/api/lib/pdf-signing/sessions";

/**
 * A user-supplied PAdES reason/location ends up inside the signature
 * dictionary, so it is capped and stripped of control characters (including
 * the line breaks that would let a value spill across dictionary entries)
 * before it is stored.
 */
const SIGNING_ANNOTATION_MAX_LENGTH = 256;

const signingAnnotationSchema = t.Optional(
  t.String({ maxLength: SIGNING_ANNOTATION_MAX_LENGTH }),
);

const C0_END = 0x1f;
const C1_START = 0x7f;
const C1_END = 0x9f;

/**
 * Replace C0 and C1 control characters with a space. Segmenter-based
 * iteration keeps a grapheme cluster (an emoji with a modifier, a combining
 * accent) whole: only the control ranges are rewritten, everything else is
 * copied through untouched.
 */
const stripControlCharacters = (value: string) => {
  const segmenter = new Intl.Segmenter();
  let sanitized = "";
  for (const { segment } of segmenter.segment(value)) {
    const codePoint = segment.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= C0_END || (codePoint >= C1_START && codePoint <= C1_END);
    sanitized += isControl ? " " : segment;
  }
  return sanitized;
};

const sanitizeSigningAnnotation = (value: string | undefined) => {
  if (value === undefined) {
    return null;
  }
  const sanitized = stripControlCharacters(value)
    .trim()
    .slice(0, SIGNING_ANNOTATION_MAX_LENGTH);
  return sanitized === "" ? null : sanitized;
};

const stripTrailingSlashes = (value: string) => {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
};

const buildPdfSigningDeepLink = ({
  apiBaseUrl,
  handoffToken,
}: {
  apiBaseUrl: string;
  handoffToken: string;
}) => {
  const url = new URL("stella://pdf-sign/open");
  url.searchParams.set("handoff", handoffToken);
  url.searchParams.set("apiBaseUrl", apiBaseUrl);
  return url.toString();
};

/** Stable codes the browser branches on to explain why signing is refused. */
const PRECONDITION_MESSAGES = {
  not_a_file: "The selected property does not hold a file.",
  not_a_pdf: "Only PDF files can be signed.",
  encrypted: "This PDF is encrypted and cannot be signed.",
  too_large: "This PDF is too large to sign.",
} as const satisfies Record<PdfSigningTargetRejection, string>;

const createPdfSigningHandoffBodySchema = t.Object({
  entityId: tSafeId("entity"),
  location: signingAnnotationSchema,
  propertyId: tSafeId("property"),
  reason: signingAnnotationSchema,
});

const config = {
  body: createPdfSigningHandoffBodySchema,
  permissions: { entity: ["update"] },
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies WorkspaceHandlerConfig;

/**
 * Refuse, before the desktop opens, a PDF whose certification forbids any
 * change. Reads the stored bytes outside any transaction; a target that is
 * missing or not signable is left for the main check to report.
 */
const refuseLockedCertification = async ({
  entityId,
  organizationId,
  propertyId,
  safeDb,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
  propertyId: SafeId<"property">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
}): Promise<Result<void, HandlerError>> => {
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
    return Result.ok(undefined);
  }
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
  return (await certificationForbidsChanges(new Uint8Array(bytes.value)))
    ? Result.err(
        new HandlerError({
          status: 422,
          code: "pdf_signing_certified_document",
          message:
            "This PDF is certified and its certification does not allow further signatures.",
        }),
      )
    : Result.ok(undefined);
};

const createPdfSigningHandoff = createSafeHandler(
  config,
  async function* ({
    body: { entityId, location, propertyId, reason },
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    yield* Result.await(
      refuseLockedCertification({
        entityId,
        organizationId: session.activeOrganizationId,
        propertyId,
        safeDb,
        workspaceId,
      }),
    );

    const sessionId = createSafeId<"pdfSigningSession">();
    const handoffToken = createPdfSigningToken();
    const expiresAt = computePdfSigningHandoffExpiresAt();

    const created = yield* Result.await(
      safeDb(async (tx) => {
        const current = await readCurrentPdfSigningTarget({
          entityId,
          propertyId,
          tx,
          workspaceId,
        });

        if (!current) {
          return {
            error: new HandlerError({
              status: 404,
              message: "Document file not found.",
            }),
          };
        }
        if (current.readOnly) {
          return {
            error: new HandlerError({
              status: 409,
              code: "entity_read_only",
              message: "This document is read-only.",
            }),
          };
        }
        if (current.target.status === "rejected") {
          return {
            error: new HandlerError({
              status: 422,
              code: `pdf_signing_${current.target.reason}`,
              message: PRECONDITION_MESSAGES[current.target.reason],
            }),
          };
        }

        const opened = await openPdfSigningSession({
          now: new Date(),
          tx,
          values: {
            baseVersionId: current.baseVersionId,
            createdBy: user.id,
            entityId,
            handoffExpiresAt: expiresAt,
            handoffTokenHash: hashPdfSigningToken(handoffToken),
            id: sessionId,
            location: sanitizeSigningAnnotation(location),
            propertyId,
            reason: sanitizeSigningAnnotation(reason),
            // Until the handoff is redeemed the exchange lives exactly as
            // long as the deep link does; redemption replaces this with the
            // session token's own TTL.
            tokenExpiresAt: expiresAt,
            workspaceId,
          },
        });
        if (opened.status === "in-progress") {
          return {
            error: new HandlerError({
              status: 409,
              code: "pdf_signing_in_progress",
              message:
                "This file is already being signed. Finish or cancel that first.",
            }),
          };
        }
        for (const expiredSessionId of opened.expiredSessionIds) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
            resourceId: expiredSessionId,
            changes: { status: { old: "open", new: "cancelled" } },
            metadata: { closeReason: "expired" },
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
          resourceId: sessionId,
          changes: {
            created: {
              old: null,
              new: {
                entityId,
                propertyId,
                baseVersionId: current.baseVersionId,
                fileName: current.target.fileContent.fileName,
              },
            },
          },
        });

        return { error: null };
      }),
    );

    if (created.error) {
      return Result.err(created.error);
    }

    return Result.ok({
      deepLinkUrl: buildPdfSigningDeepLink({
        apiBaseUrl: stripTrailingSlashes(env.PUBLIC_URL ?? env.BETTER_AUTH_URL),
        handoffToken,
      }),
      expiresAt: expiresAt.toISOString(),
      sessionId,
    });
  },
);

export default createPdfSigningHandoff;
