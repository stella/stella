import Elysia from "elysia";

import grant from "@/api/handlers/desktop-registry/grant";
import redeemLink from "@/api/handlers/desktop-registry/redeem-link";
import renew from "@/api/handlers/desktop-registry/renew";
import request from "@/api/handlers/desktop-registry/request";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import {
  DESKTOP_REGISTRY_ROUTE_PREFIX,
  DESKTOP_REGISTRY_REQUEST_ROUTE,
  desktopRegistryRequestHeaders,
} from "@/api/lib/business-registries/desktop/request-contract";

export const desktopRegistryRoute = new Elysia({
  prefix: DESKTOP_REGISTRY_ROUTE_PREFIX,
})
  .post(
    "/renew",
    {
      body: renew.config.body,
      response: renew.config.response,
    },
    renew.handler,
  )
  .post(
    DESKTOP_REGISTRY_REQUEST_ROUTE,
    {
      body: request.config.body,
      headers: desktopRegistryRequestHeaders,
    },
    request.handler,
  )
  .post("/redeem-link", { body: redeemLink.config.body }, redeemLink.handler)
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post(
    "/grant",
    {
      body: grant.config.body,
      permissions: grant.config.permissions,
    },
    grant.handler,
  );
