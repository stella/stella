import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { DocumentReferenceMatch } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { extractStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { lookupByVerificationCode } from "@/api/lib/entity-versions/document-reference-lookup";
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
  const { verificationCode } = await extractStamp(buffer);

  // Only the verification code proves which version the file came from. The
  // printed reference string is deliberately not a fallback: a matter can be
  // re-referenced and the freed reference reused, so the same string can name
  // two unrelated documents over time.
  if (!verificationCode) {
    return Result.ok(noMatch);
  }

  const match = yield* Result.await(
    safeDb(
      async (tx) =>
        await lookupByVerificationCode({
          tx,
          organizationId,
          verificationCode,
        }),
    ),
  );

  return Result.ok({ match } satisfies CheckStampResult);
};

const config = {
  description:
    "Check whether an uploaded DOCX carries a stella document reference and, " +
    "if so, which document in this organization it belongs to. Only the " +
    "embedded verification code identifies the version; the printed " +
    "reference string alone never resolves. The answer is match with the " +
    "entity id and name, its matter id and name, " +
    "the reference, the version number the reference was frozen onto, " +
    "the document's current version number (higher than that one when the " +
    "uploaded file is superseded), and currentStamp, the reference the " +
    "document's current version carries (null when it carries none; it " +
    "differs from the printed one once the document was moved to another " +
    "matter or its matter re-referenced), or match null. " +
    "Nothing is stored: this is " +
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
