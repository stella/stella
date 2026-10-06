import Elysia from "elysia";

import grant from "@/api/handlers/desktop-registry/grant";
import redeemLink from "@/api/handlers/desktop-registry/redeem-link";
import renew from "@/api/handlers/desktop-registry/renew";
import request from "@/api/handlers/desktop-registry/request";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const desktopRegistryRoute = new Elysia({ prefix: "/desktop-registry" })
  .post("/renew", renew.handler, { body: renew.config.body })
  .post("/request", request.handler, { body: request.config.body })
  .post("/redeem-link", redeemLink.handler, { body: redeemLink.config.body })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/grant", grant.handler, {
    body: grant.config.body,
    permissions: grant.config.permissions,
  });
