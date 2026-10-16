import { Result } from "better-result";

import type { Microsoft365Capability } from "@stll/api-contract/microsoft365";
/**
 * Two-layer, fail-closed enablement gate for the Microsoft 365 connection:
 *   1. deployment feature flag `FEATURE_MICROSOFT365` (a disabled deployment
 *      returns 404 so the feature's existence is not advertised); and
 *   2. per-organization opt-in `organization_settings.microsoft365ConnectionEnabled`
 *      (default false) — mirrors the org-level native-tool gating pattern.
 *
 * Every Microsoft 365 handler calls this first. Both checks fail closed.
 */

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { capabilityEnabled } from "./capabilities";

export const assertMicrosoft365ConnectionEnabled = async ({
  organizationId,
  safeDb,
  capabilities = [],
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  capabilities?: readonly Microsoft365Capability[];
}): Promise<Result<void, HandlerError<403 | 404> | SafeDbError>> =>
  await Result.gen(async function* () {
    if (!isDeploymentFeatureEnabled("FEATURE_MICROSOFT365")) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }

    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: {
            microsoft365ConnectionEnabled: true,
            microsoft365FilesReadEnabled: true,
            microsoft365CalendarReadEnabled: true,
          },
        }),
      ),
    );

    if (
      !settings?.microsoft365ConnectionEnabled ||
      capabilities.some(
        (capability) => !capabilityEnabled(settings, capability),
      )
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message:
            "Microsoft 365 connection is not enabled for this organization",
        }),
      );
    }

    return Result.ok(undefined);
  });
