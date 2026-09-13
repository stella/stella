import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { lookupByVerificationCode } from "@/api/lib/entity-versions/document-reference-lookup";

/**
 * Resolve a verification code to the document version it was frozen onto.
 *
 * Scoped to the caller's organization to prevent cross-org information
 * disclosure. The frontend calls this after the user logs in via the
 * `/verify/:code` route, and shows which document and matter the code names
 * plus whether the file in hand is still the current version.
 */
export const resolveVerificationCodeAuth = async (
  code: string,
  organizationId: SafeId<"organization">,
  scopedDb: ScopedDb,
) => {
  const match = await scopedDb(
    async (tx) =>
      await lookupByVerificationCode({
        tx,
        organizationId,
        verificationCode: code,
      }),
  );

  return match ?? status(404);
};
