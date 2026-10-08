/**
 * Verification history for one document, newest first.
 *
 * Keyset-paginated on `(created_at, id)` descending, matching the
 * `(workspace_id, entity_id, file_field_id, created_at DESC, id DESC)` index.
 * Claim counts per verdict state are aggregated in the same statement, and
 * the pinned evidence is projected down to the list it came from rather than
 * sent whole.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import { listRunSummaries } from "@/api/lib/lists/verification/run-summary";
import type {
  RunRow,
  RunSummaryColumnProjection,
  UNPROJECTED_RUN_SUMMARY_COLUMNS,
} from "@/api/lib/lists/verification/run-summary";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const config = {
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "List the list verifications of one document, newest first with cursor " +
    "pagination: each run's status, failure code, the list it checked " +
    "against, when it was started and finished, and how many claims landed " +
    "in each verdict state. Read one run in full with lists.verifications.get.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({}),
  query: t.Object({
    entityId: tSafeId("entity"),
    fileFieldId: tSafeId("field"),
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.legalListVerificationRunsPageSizeMax,
      }),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const readVerifications = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.legalListVerificationRunsPageSizeDefault,
    );
    const page = yield* Result.await(
      listRunSummaries({
        safeDb,
        workspaceId,
        entityId: query.entityId,
        fileFieldId: query.fileFieldId,
        cursor: query.cursor,
        limit,
      }),
    );
    return Result.ok(page);
  },
);

type MissingProjectedRunColumn = UnprojectedColumns<
  RunRow,
  RunSummaryColumnProjection,
  (typeof UNPROJECTED_RUN_SUMMARY_COLUMNS)[number]
>;
type UnexpectedProjectedRunColumn = UnbackedProjectionKeys<
  RunRow,
  RunSummaryColumnProjection,
  (typeof UNPROJECTED_RUN_SUMMARY_COLUMNS)[number]
>;

true satisfies MissingProjectedRunColumn extends never ? true : never;
true satisfies UnexpectedProjectedRunColumn extends never ? true : never;

export default readVerifications;
