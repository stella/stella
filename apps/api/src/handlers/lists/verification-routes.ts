import Elysia from "elysia";

import updateFactDetails from "@/api/handlers/lists/items/fact-details/update";
import verifyItemSource from "@/api/handlers/lists/items/sources/verification/update";
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
    .patch("/item-sources", verifyItemSource.handler, {
      body: verifyItemSource.config.body,
      permissions: verifyItemSource.config.permissions,
    })
    .put("/item-fact-details", updateFactDetails.handler, {
      body: updateFactDetails.config.body,
      permissions: updateFactDetails.config.permissions,
    })
    .post("/claim-reviews", createClaimReview.handler, {
      body: createClaimReview.config.body,
      permissions: createClaimReview.config.permissions,
    })
    .post("/claim-reviews/bulk", createBulkClaimReviews.handler, {
      body: createBulkClaimReviews.config.body,
      permissions: createBulkClaimReviews.config.permissions,
    })
    .post("/verifications", createVerification.handler, {
      body: createVerification.config.body,
      permissions: createVerification.config.permissions,
    })
    .post("/verifications/latest", readLatestVerifications.handler, {
      body: readLatestVerifications.config.body,
      permissions: readLatestVerifications.config.permissions,
    })
    .get("/verifications", readVerifications.handler, {
      params: readVerifications.config.params,
      permissions: readVerifications.config.permissions,
      query: readVerifications.config.query,
    })
    .get("/verifications/:runId", readVerification.handler, {
      params: readVerification.config.params,
      permissions: readVerification.config.permissions,
    });
