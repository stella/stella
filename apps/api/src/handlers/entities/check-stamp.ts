import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentReferenceMatch } from "@/api/lib/document-reference-lookup";
import {
  lookupByStamp,
  lookupByVerificationCode,
} from "@/api/lib/document-reference-lookup";
import { extractStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

const checkStampBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

type CheckStampHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  body: Static<typeof checkStampBodySchema>;
};

type CheckStampResult = { match: DocumentReferenceMatch | null };

/**
 * Check if an uploaded DOCX carries a stella document reference and
 * resolve it to an existing entity within the user's org.
 *
 * Returns match info for the frontend to offer "update
 * existing" vs "upload as new" options.
 *
 * @yields {Err} on database lookup failure
 */
const checkStampHandler = async function* ({
  safeDb,
  organizationId,
  body: { file },
}: CheckStampHandlerProps) {
  const noMatch: CheckStampResult = { match: null };

  if (!isStampableDocx(file.type, file.size)) {
    return Result.ok(noMatch);
  }

  const buffer = await file.arrayBuffer();
  const { stamp, verificationCode } = await extractStamp(buffer);

  if (!verificationCode && !stamp) {
    return Result.ok(noMatch);
  }

  // Both attempts share one RLS transaction: the verification code is
  // globally unique so it decides on its own, and the reference string is
  // only consulted when the document carries no code or the code resolved to
  // nothing this organization can see.
  const match = yield* Result.await(
    safeDb(async (tx) => {
      if (verificationCode) {
        const byCode = await lookupByVerificationCode({
          tx,
          organizationId,
          verificationCode,
        });
        if (byCode) {
          return byCode;
        }
      }
      return stamp ? await lookupByStamp({ tx, organizationId, stamp }) : null;
    }),
  );

  return Result.ok({ match } satisfies CheckStampResult);
};

const config = {
  description:
    "Check whether an uploaded DOCX carries a stella document reference and, " +
    "if so, which document in this organization it belongs to. The embedded " +
    "verification code is tried first, then the reference string, and the " +
    "answer is match with the entity id and name, its matter id and name, " +
    "the reference, the version number the reference was frozen onto, and " +
    "the document's current version number (higher than that one when the " +
    "uploaded file is superseded), or match null. Nothing is stored: this is " +
    "what distinguishes adding a new version of an existing document from " +
    "uploading a new one.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "document_processing" },
  access: "read",
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [] },
    alternative: {
      type: "none",
      reason:
        "the lookup reads a reference out of the supplied document's bytes; no capability accepts the reference on its own",
    },
  },
  body: checkStampBodySchema,
} satisfies HandlerConfig;

const checkStamp = createSafeHandler(
  config,
  async function* ({ safeDb, session, body }) {
    return yield* checkStampHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      body,
    });
  },
);

export default checkStamp;
