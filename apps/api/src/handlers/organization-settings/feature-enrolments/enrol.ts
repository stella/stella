import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { featureEnrolments } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FEATURE_REGISTRY,
  SELF_SERVE_FEATURE_IDS,
} from "@/api/lib/feature-access/registry";

const config = {
  description:
    "Enable a self-serve feature for yourself in the active organization.",
  // permissions-exempt: this mutation changes only the caller's own preference under user + organization RLS.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "internal", reason: "ui_navigation_state" },
  params: t.Object({ featureId: t.UnionEnum(SELF_SERVE_FEATURE_IDS) }),
} satisfies HandlerConfig;

export type EnrolFeatureHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  featureId: (typeof SELF_SERVE_FEATURE_IDS)[number];
  recordAuditEvent: AuditRecorder;
};

// Shared self-serve enrolment reused by the settings toggle and the review
// organization seed, so both write the same preference and audit row.
export const enrolFeatureHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  featureId,
  recordAuditEvent,
}: EnrolFeatureHandlerProps) {
  if (
    !isDeploymentFeatureEnabled(FEATURE_REGISTRY[featureId].deploymentFeature)
  ) {
    return Result.err(new HandlerError({ status: 404, message: "Not found" }));
  }
  yield* Result.await(
    safeDb(async (tx) => {
      const rows = await tx
        .insert(featureEnrolments)
        .values({ userId, organizationId, featureId })
        .onConflictDoNothing()
        .returning({ featureId: featureEnrolments.featureId });
      if (rows.length === 0) {
        return;
      }
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId: organizationId,
        metadata: {
          field: "featureEnrolment",
          featureId,
          enrolled: true,
        },
      });
    }),
  );
  return Result.ok({ featureId, enrolled: true });
};

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, recordAuditEvent }) {
    return yield* enrolFeatureHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      featureId: params.featureId,
      recordAuditEvent,
    });
  },
);
