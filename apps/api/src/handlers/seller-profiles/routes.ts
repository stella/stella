import archiveSellerProfile from "@/api/handlers/seller-profiles/archive";
import createSellerProfile from "@/api/handlers/seller-profiles/create";
import updateSellerProfileDefault from "@/api/handlers/seller-profiles/default/update";
import getSellerProfile from "@/api/handlers/seller-profiles/get";
import listSellerProfiles from "@/api/handlers/seller-profiles/list";
import updateSellerProfile from "@/api/handlers/seller-profiles/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const sellerProfilesRoute = routes(
  {
    "/": { GET: listSellerProfiles, POST: createSellerProfile },
    "/:sellerProfileId": { GET: getSellerProfile, PATCH: updateSellerProfile },
    "/:sellerProfileId/default": { POST: updateSellerProfileDefault },
    "/:sellerProfileId/archive": { POST: archiveSellerProfile },
  },
  {
    prefix: "/seller-profiles",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
