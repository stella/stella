/**
 * The latest verification of each of several documents, in one read: a
 * matter's document list shows every document's status at once, and one
 * request per document is the round trip this avoids.
 */

import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import { listLatestRunSummaries } from "@/api/lib/lists/verification/run-summary";
import type {
  RunRow,
  RunSummaryColumnProjection,
  UNPROJECTED_RUN_SUMMARY_COLUMNS,
} from "@/api/lib/lists/verification/run-summary";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

const config = {
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Read the latest list verification of each named document file (entity " +
    "id and file field id), in one call: its status, failure code, the list " +
    "it checked against, when it started and finished, and claim counts per " +
    "verdict state. A file never verified is absent from the answer. Earlier " +
    "runs are in lists.verifications.list.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  body: t.Object({
    documents: t.Array(
      t.Object(
        { entityId: tSafeId("entity"), fileFieldId: tSafeId("field") },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: VERIFICATION_LIMITS.LATEST_READ_DOCUMENTS_MAX,
        uniqueItems: true,
      },
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const readLatestVerifications = createSafeHandler(
  config,
  async function* ({ body: { documents }, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      listLatestRunSummaries({ safeDb, workspaceId, documents }),
    );
    return Result.ok({ runs });
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

export default readLatestVerifications;
