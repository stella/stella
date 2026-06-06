import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { usageEntitlements } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createHostedManagementSession } from "@/api/lib/hosted-usage-provider/client";
import { getApiCredentials } from "@/api/lib/hosted-usage-provider/config";

/** Create a hosted usage-management session for the caller's organisation. */

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

const createHostedManagement = createSafeRootHandler(
  config,
  async function* ({ session, safeDb }) {
    const credentials = getApiCredentials();
    if (!credentials) {
      return Result.err(
        new HandlerError({
          status: 502,
          message:
            "Hosted usage management is not configured on this deployment",
        }),
      );
    }

    const dbResult = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            source: usageEntitlements.source,
            hostedAccountRef: usageEntitlements.hostedAccountRef,
          })
          .from(usageEntitlements)
          .where(
            eq(usageEntitlements.organizationId, session.activeOrganizationId),
          )
          .limit(1);
        return rows.at(0) ?? null;
      }),
    );

    if (
      !dbResult ||
      dbResult.source !== "hosted" ||
      !dbResult.hostedAccountRef
    ) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "No hosted usage entitlement for this organisation",
        }),
      );
    }

    const sessionResult = await createHostedManagementSession({
      credentials,
      accountRef: dbResult.hostedAccountRef,
      returnUrl: `${env.FRONTEND_URL.replace(/\/$/u, "")}/settings/organization/usage`,
    });
    if (Result.isError(sessionResult)) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Could not create hosted usage management session",
          cause: sessionResult.error,
        }),
      );
    }

    return Result.ok({ url: sessionResult.value.url });
  },
);

export default createHostedManagement;
