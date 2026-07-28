/**
 * Two-layer, fail-closed enablement gate for the SharePoint connection:
 *   1. deployment feature flag `FEATURE_SHAREPOINT` (a disabled deployment
 *      returns 404 so the feature's existence is not advertised); and
 *   2. per-organization opt-in `organization_settings.sharepointConnectionEnabled`
 *      (default false) — mirrors the org-level native-tool gating pattern.
 *
 * Every SharePoint handler calls this first. Both checks fail closed.
 */

import { Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const assertSharepointConnectionEnabled = async ({
  organizationId,
  safeDb,
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
}): Promise<Result<void, HandlerError<403 | 404> | SafeDbError>> =>
  await Result.gen(async function* () {
    if (!env.FEATURE_SHAREPOINT) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }

    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: { sharepointConnectionEnabled: true },
        }),
      ),
    );

    if (!settings?.sharepointConnectionEnabled) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "SharePoint connection is not enabled for this organization",
        }),
      );
    }

    return Result.ok(undefined);
  });
