import { Result } from "better-result";
import { t } from "elysia";

import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  preflightPdfSigning,
  STAMP_LABEL_MAX_LENGTH,
} from "@/api/lib/pdf-signing/handoff-preflight";
import type { PdfSigningTargetRejection } from "@/api/lib/pdf-signing/pdf-target";
import { readCurrentPdfSigningTarget } from "@/api/lib/pdf-signing/pdf-target";
import {
  computePdfSigningHandoffExpiresAt,
  createPdfSigningToken,
  hashPdfSigningToken,
  openPdfSigningSession,
} from "@/api/lib/pdf-signing/sessions";
import { sanitizeSigningText } from "@/api/lib/pdf-signing/signing-text";

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

const sanitizeSigningAnnotation = (value: string | undefined) =>
  sanitizeSigningText(value, SIGNING_ANNOTATION_MAX_LENGTH);

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

const stampLabelSchema = t.String({ maxLength: STAMP_LABEL_MAX_LENGTH });

/**
 * A visible stamp: a box drawn on the displayed page in fractions of it,
 * and the fixed labels in the signer's language. Omitted for an invisible
 * signature.
 */
const stampRequestSchema = t.Optional(
  t.Object({
    box: t.Object({
      height: t.Number(),
      width: t.Number(),
      x: t.Number(),
      y: t.Number(),
    }),
    direction: t.UnionEnum(["ltr", "rtl"]),
    labels: t.Object({
      date: stampLabelSchema,
      location: stampLabelSchema,
      reason: stampLabelSchema,
      signedBy: stampLabelSchema,
    }),
    pageIndex: t.Integer({ minimum: 0 }),
    timeZone: t.String({ minLength: 1, maxLength: 64 }),
  }),
);

const createPdfSigningHandoffBodySchema = t.Object({
  entityId: tSafeId("entity"),
  location: signingAnnotationSchema,
  propertyId: tSafeId("property"),
  reason: signingAnnotationSchema,
  stamp: stampRequestSchema,
});

const config = {
  body: createPdfSigningHandoffBodySchema,
  permissions: { entity: ["update"] },
  mcp: { type: "internal", reason: "session_token_exchange" },
} satisfies WorkspaceHandlerConfig;

const createPdfSigningHandoff = createSafeHandler(
  config,
  async function* ({
    body: { entityId, location, propertyId, reason, stamp },
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const placedStamp = yield* Result.await(
      preflightPdfSigning({
        entityId,
        organizationId: session.activeOrganizationId,
        propertyId,
        safeDb,
        stamp,
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
            stamp: placedStamp,
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
