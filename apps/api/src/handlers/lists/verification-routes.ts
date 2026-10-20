import Elysia from "elysia";

import updateFactDetails from "@/api/handlers/lists/items/fact-details/update";
import verifyItemSource from "@/api/handlers/lists/items/sources/verification/update";
import createSampleCase from "@/api/handlers/lists/sample-case/create";
import createBulkClaimReviews from "@/api/handlers/lists/verifications/claim-reviews/bulk/create";
import createClaimReview from "@/api/handlers/lists/verifications/claim-reviews/create";
import createVerification from "@/api/handlers/lists/verifications/create";
import readVerification from "@/api/handlers/lists/verifications/get";
import readLatestVerifications from "@/api/handlers/lists/verifications/latest/list";
import readVerifications from "@/api/handlers/lists/verifications/list";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";

export const createListVerificationRoutes = (
  dependencies?: Parameters<typeof featureAccessGate>[1],
) =>
  new Elysia()
    .use(featureAccessGate("list-verification", dependencies))
    .use(workspaceAccessMacro)
    .use(permissionMacro)
    .guard({ validateWorkspaceAccess: true })
    .patch(
      "/item-sources",
      {
        body: verifyItemSource.config.body,
        permissions: verifyItemSource.config.permissions,
      },
      verifyItemSource.handler,
    )
    .put(
      "/item-fact-details",
      {
        body: updateFactDetails.config.body,
        permissions: updateFactDetails.config.permissions,
      },
      updateFactDetails.handler,
    )
    .post(
      "/claim-reviews",
      {
        body: createClaimReview.config.body,
        permissions: createClaimReview.config.permissions,
      },
      createClaimReview.handler,
    )
    .post(
      "/claim-reviews/bulk",
      {
        body: createBulkClaimReviews.config.body,
        permissions: createBulkClaimReviews.config.permissions,
      },
      createBulkClaimReviews.handler,
    )
    .post(
      "/sample-case",
      {
        body: createSampleCase.config.body,
        permissions: createSampleCase.config.permissions,
      },
      createSampleCase.handler,
    )
    .post(
      "/verifications",
      {
        body: createVerification.config.body,
        permissions: createVerification.config.permissions,
      },
      createVerification.handler,
    )
    .post(
      "/verifications/latest",
      {
        body: readLatestVerifications.config.body,
        permissions: readLatestVerifications.config.permissions,
      },
      readLatestVerifications.handler,
    )
    .get(
      "/verifications",
      {
        params: readVerifications.config.params,
        permissions: readVerifications.config.permissions,
        query: readVerifications.config.query,
      },
      readVerifications.handler,
    )
    .get(
      "/verifications/:runId",
      {
        params: readVerification.config.params,
        permissions: readVerification.config.permissions,
      },
      readVerification.handler,
    );
