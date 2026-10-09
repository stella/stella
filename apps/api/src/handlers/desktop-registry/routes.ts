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
  .post("/renew", renew.handler, {
    body: renew.config.body,
    response: renew.config.response,
  })
  .post(DESKTOP_REGISTRY_REQUEST_ROUTE, request.handler, {
    body: request.config.body,
    headers: desktopRegistryRequestHeaders,
  })
  .post("/redeem-link", redeemLink.handler, { body: redeemLink.config.body })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/grant", grant.handler, {
    body: grant.config.body,
    permissions: grant.config.permissions,
  });
