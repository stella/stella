/**
 * The comments on one claim of a list verification that the caller can see:
 * their own, and those colleagues on the matter shared. Oldest first, in the
 * reader-annotation shape the case-law reader reads its comments in.
 */

import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { listReaderAnnotationsHandler } from "@/api/lib/legal-search/reader-annotations/list";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "List the comments on one claim of a list verification that the user " +
    "can see: their own, and those colleagues on the matter shared, oldest " +
    "first with cursor pagination. Each comment names its author and " +
    "whether it is the user's own.",
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
  query: v.object({
    runId: resourceIdSchema("legalListVerificationRun"),
    claimId: resourceIdSchema("legalListClaim"),
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        paginationLimitSchema(LIMITS.readerAnnotationsPageSizeMax),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const listClaimComments = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, user, workspaceId }) {
    const { claimId, cursor, limit, runId } = query;
    return yield* listReaderAnnotationsHandler({
      organizationId: session.activeOrganizationId,
      query: {
        targetId: claimId,
        targetType: "verification-claim",
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
      safeDb,
      userId: user.id,
      verificationClaim: { claimId, runId, workspaceId },
    });
  },
);

export default listClaimComments;
