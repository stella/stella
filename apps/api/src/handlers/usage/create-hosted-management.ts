import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { abortableTx } from "@/api/db/safe-db";
import { usageEntitlements } from "@/api/db/schema";
import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { requireCurrentOrganizationMemberPermission } from "@/api/lib/db/member-authority";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createHostedManagementSession } from "@/api/lib/hosted-usage-provider/client";
import { getApiCredentials } from "@/api/lib/hosted-usage-provider/config";

/** Create a hosted usage-management session for the caller's organisation. */

const config = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "hosted_billing" },
} satisfies HandlerConfig;

const createHostedManagement = createSafeRootHandler(
  config,
  async function* ({ session, safeDb, user }) {
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
      returnUrl: `${env.FRONTEND_URL.replace(/\/$/u, "")}/admin/usage`,
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

    yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await requireCurrentOrganizationMemberPermission({
          db: tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          permissions: { organizationSettings: ["update"] },
        });
      }),
    );

    return Result.ok({ url: sessionResult.value.url });
  },
);

export default createHostedManagement;
