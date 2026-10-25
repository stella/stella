import Elysia from "elysia";

import updateFactDetails from "@/api/handlers/lists/items/fact-details/update";
import verifyItemSource from "@/api/handlers/lists/items/sources/verification/update";
import createSampleCase from "@/api/handlers/lists/sample-case/create";
import createClaimComment from "@/api/handlers/lists/verifications/claim-comments/create";
import deleteClaimComment from "@/api/handlers/lists/verifications/claim-comments/delete";
import listClaimComments from "@/api/handlers/lists/verifications/claim-comments/list";
import updateClaimComment from "@/api/handlers/lists/verifications/claim-comments/update";
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
      accountAccess: verifyItemSource.config.accountAccess,
    })
    .put("/item-fact-details", updateFactDetails.handler, {
      body: updateFactDetails.config.body,
      permissions: updateFactDetails.config.permissions,
      accountAccess: updateFactDetails.config.accountAccess,
    })
    .post("/claim-reviews", createClaimReview.handler, {
      body: createClaimReview.config.body,
      permissions: createClaimReview.config.permissions,
      accountAccess: createClaimReview.config.accountAccess,
    })
    .post("/claim-reviews/bulk", createBulkClaimReviews.handler, {
      body: createBulkClaimReviews.config.body,
      permissions: createBulkClaimReviews.config.permissions,
      accountAccess: createBulkClaimReviews.config.accountAccess,
    })
    .get("/claim-comments", listClaimComments.handler, {
      params: listClaimComments.config.params,
      permissions: listClaimComments.config.permissions,
      accountAccess: listClaimComments.config.accountAccess,
      query: listClaimComments.config.query,
    })
    .post("/claim-comments", createClaimComment.handler, {
      body: createClaimComment.config.body,
      params: createClaimComment.config.params,
      permissions: createClaimComment.config.permissions,
      accountAccess: createClaimComment.config.accountAccess,
    })
    .patch("/claim-comments/:annotationId", updateClaimComment.handler, {
      body: updateClaimComment.config.body,
      params: updateClaimComment.config.params,
      permissions: updateClaimComment.config.permissions,
      accountAccess: updateClaimComment.config.accountAccess,
    })
    .delete("/claim-comments/:annotationId", deleteClaimComment.handler, {
      params: deleteClaimComment.config.params,
      permissions: deleteClaimComment.config.permissions,
      accountAccess: deleteClaimComment.config.accountAccess,
    })
    .post("/sample-case", createSampleCase.handler, {
      body: createSampleCase.config.body,
      permissions: createSampleCase.config.permissions,
      accountAccess: createSampleCase.config.accountAccess,
    })
    .post("/verifications", createVerification.handler, {
      body: createVerification.config.body,
      permissions: createVerification.config.permissions,
      accountAccess: createVerification.config.accountAccess,
    })
    .post("/verifications/latest", readLatestVerifications.handler, {
      body: readLatestVerifications.config.body,
      permissions: readLatestVerifications.config.permissions,
      accountAccess: readLatestVerifications.config.accountAccess,
    })
    .get("/verifications", readVerifications.handler, {
      params: readVerifications.config.params,
      permissions: readVerifications.config.permissions,
      accountAccess: readVerifications.config.accountAccess,
      query: readVerifications.config.query,
    })
    .get("/verifications/:runId", readVerification.handler, {
      params: readVerification.config.params,
      permissions: readVerification.config.permissions,
      accountAccess: readVerification.config.accountAccess,
    });
