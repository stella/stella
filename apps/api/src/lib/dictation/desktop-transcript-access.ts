import { Result } from "better-result";
import type { InferOk } from "better-result";

import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";

// Filing a transcript belongs with dictation on the desktop: it is what the
// member transcribed there, on this computer or with stella AI.
const REQUIRED_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;

export type DesktopTranscriptAccount = InferOk<
  Awaited<ReturnType<typeof authorizeDesktopAccount>>
>;

/** The linked desktop's account, once the member's dictation decision
 *  allows filing what it transcribed. Shared by the routes that file a
 *  transcript and finalize its recording. */
export const authorizeDesktopTranscriptSave = async (
  request: Request,
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  await Result.gen(async function* () {
    const account = yield* Result.await(authorizeAccount(request));
    if (
      !isFeatureEnabled(
        account.featureAccessSnapshot,
        REQUIRED_FEATURE_ID,
        account,
      )
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Recording transcription is unavailable",
        }),
      );
    }
    return Result.ok(account);
  });

/** The matter under the member's own access, as a document write sees it. */
export const readDesktopTranscriptMatter = async (
  account: DesktopTranscriptAccount,
  matterId: SafeId<"workspace">,
) =>
  await safeDbFromScoped(account.scopedDb)(
    async (tx) =>
      (await tx.query.workspaces.findFirst({
        where: {
          id: { eq: matterId },
          organizationId: { eq: account.organizationId },
        },
        columns: { id: true, status: true },
      })) ?? null,
  );
