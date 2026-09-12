import Elysia from "elysia";

import create from "@/api/handlers/sso/create";
import deleteConnection from "@/api/handlers/sso/delete";
import read from "@/api/handlers/sso/read";
import requestDomainVerification from "@/api/handlers/sso/request-domain-verification";
import updateEnforcement from "@/api/handlers/sso/update-enforcement";
import verifyDomain from "@/api/handlers/sso/verify-domain";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const ssoConnectionsRoute = new Elysia({ prefix: "/sso-connections" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", read.handler, {
    permissions: read.config.permissions,
  })
  .post("/", create.handler, {
    body: create.config.body,
    permissions: create.config.permissions,
  })
  .post("/domain-verification", requestDomainVerification.handler, {
    permissions: requestDomainVerification.config.permissions,
  })
  .post("/verify-domain", verifyDomain.handler, {
    permissions: verifyDomain.config.permissions,
  })
  .post("/enforcement", updateEnforcement.handler, {
    body: updateEnforcement.config.body,
    permissions: updateEnforcement.config.permissions,
  })
  .delete("/", deleteConnection.handler, {
    permissions: deleteConnection.config.permissions,
  });
