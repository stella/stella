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
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";

/** List verification answers like an absent route for a caller without the feature. */
export const createListVerificationRoutes = (
  dependencies?: Parameters<typeof featureAccessGate>[1],
) =>
  routes(
    {
      "/item-sources": { PATCH: verifyItemSource },
      "/item-fact-details": { PUT: updateFactDetails },
      "/claim-reviews": { POST: createClaimReview },
      "/claim-reviews/bulk": { POST: createBulkClaimReviews },
      "/claim-comments": { GET: listClaimComments, POST: createClaimComment },
      "/claim-comments/:annotationId": {
        PATCH: updateClaimComment,
        DELETE: deleteClaimComment,
      },
      "/sample-case": { POST: createSampleCase },
      "/verifications": {
        GET: readVerifications,
        POST: createVerification,
      },
      "/verifications/latest": { POST: readLatestVerifications },
      "/verifications/:runId": { GET: readVerification },
    },
    { middleware: [featureAccessGate("list-verification", dependencies)] },
  );
