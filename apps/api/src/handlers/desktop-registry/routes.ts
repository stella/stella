import Elysia from "elysia";

import grant from "@/api/handlers/desktop-registry/grant";
import request from "@/api/handlers/desktop-registry/request";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const desktopRegistryRoute = new Elysia({ prefix: "/desktop-registry" })
  .post("/request", request.handler, { body: request.config.body })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/grant", grant.handler, {
    body: grant.config.body,
    permissions: grant.config.permissions,
  });
