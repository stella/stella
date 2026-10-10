import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { featureEnrolments } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readBounded } from "@/api/lib/db/read-bounded";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  FEATURE_REGISTRY,
  SELF_SERVE_FEATURE_IDS,
} from "@/api/lib/feature-access/registry";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type FeatureEnrolmentRow = typeof featureEnrolments.$inferSelect;

const UNPROJECTED_FEATURE_ENROLMENT_COLUMNS = [
  // Scope comes from the session; the response carries only offered features and their state.
  "userId",
  "organizationId",
  "createdAt",
] as const satisfies readonly (keyof FeatureEnrolmentRow)[];

const FEATURE_ENROLMENT_COLUMNS = { featureId: true } as const;

type MissingFeatureEnrolmentColumn = UnprojectedColumns<
  FeatureEnrolmentRow,
  typeof FEATURE_ENROLMENT_COLUMNS,
  (typeof UNPROJECTED_FEATURE_ENROLMENT_COLUMNS)[number]
>;
type UnexpectedFeatureEnrolmentColumn = UnbackedProjectionKeys<
  FeatureEnrolmentRow,
  typeof FEATURE_ENROLMENT_COLUMNS,
  (typeof UNPROJECTED_FEATURE_ENROLMENT_COLUMNS)[number]
>;

true satisfies MissingFeatureEnrolmentColumn extends never ? true : never;
true satisfies UnexpectedFeatureEnrolmentColumn extends never ? true : never;

const config = {
  description:
    "List the offered self-serve features and your enrolment in the active organization.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "ui_navigation_state" },
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    // The registry bounds this preference list; pagination would split one settings snapshot.
    const rows = yield* Result.await(
      safeDb(async (tx) => {
        const read = await readBounded(
          tx
            .select({ featureId: featureEnrolments.featureId })
            .from(featureEnrolments)
            .where(
              and(
                eq(featureEnrolments.userId, user.id),
                eq(
                  featureEnrolments.organizationId,
                  session.activeOrganizationId,
                ),
              ),
            ),
          SELF_SERVE_FEATURE_IDS.length,
        );
        // The primary key and feature-id check bound each caller to the registry.
        if (read.type === "overflow") {
          return panic("Feature enrolments exceed the self-serve registry");
        }
        return read.rows;
      }),
    );
    const enrolled = new Set(rows.map(({ featureId }) => featureId));
    return Result.ok({
      features: SELF_SERVE_FEATURE_IDS.filter((featureId) =>
        isDeploymentFeatureEnabled(
          FEATURE_REGISTRY[featureId].deploymentFeature,
        ),
      ).map((featureId) => ({ featureId, enrolled: enrolled.has(featureId) })),
    });
  },
);
