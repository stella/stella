import Elysia from "elysia";
import { rateLimit } from "elysia-rate-limit";

import createShareSpace from "@/api/handlers/share-spaces/create";
import exchangeShareInvitation from "@/api/handlers/share-spaces/exchange";
import getShareSpace from "@/api/handlers/share-spaces/get";
import createExternalShareItemUrl from "@/api/handlers/share-spaces/item-url";
import listShareSpaces from "@/api/handlers/share-spaces/list";
import readExternalShareManifest from "@/api/handlers/share-spaces/manifest";
import requestShareOtp from "@/api/handlers/share-spaces/request-otp";
import createShareSpaceRevocation from "@/api/handlers/share-spaces/revocations/create";
import {
  permissionMacro,
  sessionAuthMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

export const shareSpacesRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/share-spaces",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .get("/", listShareSpaces.handler, {
    query: listShareSpaces.config.query,
    permissions: listShareSpaces.config.permissions,
  })
  .post("/publish-document", createShareSpace.handler, {
    body: createShareSpace.config.body,
    params: createShareSpace.config.params,
    permissions: createShareSpace.config.permissions,
  })
  .get("/:shareSpaceId", getShareSpace.handler, {
    params: getShareSpace.config.params,
    permissions: getShareSpace.config.permissions,
  })
  .post("/:shareSpaceId/revoke", createShareSpaceRevocation.handler, {
    params: createShareSpaceRevocation.config.params,
    permissions: createShareSpaceRevocation.config.permissions,
  });

const shareOtpRoute = new Elysia()
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.shareSpaceOtp.duration,
      max: API_RATE_LIMITS.shareSpaceOtp.max,
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "share-space-otp",
      }),
    }),
  )
  .post("/request-otp", requestShareOtp.handler, {
    body: requestShareOtp.config.body,
  });

const verifiedShareRoute = new Elysia()
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .post("/exchange", exchangeShareInvitation.handler, {
    body: exchangeShareInvitation.config.body,
  })
  .get("/:shareSpaceId", readExternalShareManifest.handler, {
    params: readExternalShareManifest.config.params,
  })
  .get(
    "/:shareSpaceId/items/:shareItemId/url",
    createExternalShareItemUrl.handler,
    {
      params: createExternalShareItemUrl.config.params,
      query: createExternalShareItemUrl.config.query,
    },
  );

export const shareSpaceAccessRoute = new Elysia({
  prefix: "/share-spaces/access",
})
  .use(shareOtpRoute)
  .use(verifiedShareRoute);
