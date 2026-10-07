import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { featureEnrolments } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FEATURE_REGISTRY,
  SELF_SERVE_FEATURE_IDS,
} from "@/api/lib/feature-access/registry";

const config = {
  description:
    "Disable a self-serve feature for yourself in the active organization.",
  // permissions-exempt: this mutation changes only the caller's own preference under user + organization RLS.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "internal", reason: "ui_navigation_state" },
  params: t.Object({ featureId: t.UnionEnum(SELF_SERVE_FEATURE_IDS) }),
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, recordAuditEvent }) {
    if (
      !isDeploymentFeatureEnabled(
        FEATURE_REGISTRY[params.featureId].deploymentFeature,
      )
    ) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }
    yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(featureEnrolments)
          .where(
            and(
              eq(featureEnrolments.userId, user.id),
              eq(
                featureEnrolments.organizationId,
                session.activeOrganizationId,
              ),
              eq(featureEnrolments.featureId, params.featureId),
            ),
          )
          .returning({ featureId: featureEnrolments.featureId });
        if (rows.length === 0) {
          return;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "featureEnrolment",
            featureId: params.featureId,
            enrolled: false,
          },
        });
      }),
    );
    return Result.ok({ featureId: params.featureId, enrolled: false });
  },
);
