import Elysia from "elysia";

import archiveSellerProfile from "@/api/handlers/seller-profiles/archive";
import createSellerProfile from "@/api/handlers/seller-profiles/create";
import updateSellerProfileDefault from "@/api/handlers/seller-profiles/default/update";
import getSellerProfile from "@/api/handlers/seller-profiles/get";
import listSellerProfiles from "@/api/handlers/seller-profiles/list";
import updateSellerProfile from "@/api/handlers/seller-profiles/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const sellerProfilesRoute = new Elysia({ prefix: "/seller-profiles" })
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listSellerProfiles.handler, {
    permissions: listSellerProfiles.config.permissions,
    query: listSellerProfiles.config.query,
  })
  .post("/", createSellerProfile.handler, {
    permissions: createSellerProfile.config.permissions,
    body: createSellerProfile.config.body,
  })
  .get("/:sellerProfileId", getSellerProfile.handler, {
    permissions: getSellerProfile.config.permissions,
    params: getSellerProfile.config.params,
  })
  .patch("/:sellerProfileId", updateSellerProfile.handler, {
    permissions: updateSellerProfile.config.permissions,
    params: updateSellerProfile.config.params,
    body: updateSellerProfile.config.body,
  })
  .post("/:sellerProfileId/default", updateSellerProfileDefault.handler, {
    permissions: updateSellerProfileDefault.config.permissions,
    params: updateSellerProfileDefault.config.params,
  })
  .post("/:sellerProfileId/archive", archiveSellerProfile.handler, {
    permissions: archiveSellerProfile.config.permissions,
    params: archiveSellerProfile.config.params,
  });
