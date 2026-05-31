import Elysia from "elysia";

import installBundledSkill from "@/api/handlers/catalogue/install-skill";
import listCatalogue from "@/api/handlers/catalogue/list-catalogue";
import nativeToolDeployAvailability from "@/api/handlers/catalogue/native-tool-deploy-availability";
import { authMacro, permissionMacro, sessionAuthMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

const sessionCatalogueRoute = new Elysia({ prefix: "/catalogue" })
  .use(sessionAuthMacro)
  .guard({ validateSession: true })
  .get(
    "/native-tool-deploy-availability",
    nativeToolDeployAvailability.handler,
  );

const authenticatedCatalogueRoute = new Elysia({ prefix: "/catalogue" })
  .use(authMacro)
  .use(permissionMacro)
  .use(invalidateQuery)
  .guard({ validateAuth: true })
  .get("/", listCatalogue.handler, {
    permissions: listCatalogue.config.permissions,
  })
  .post("/install-skill", installBundledSkill.handler, {
    body: installBundledSkill.config.body,
    invalidateQuery: true,
    permissions: installBundledSkill.config.permissions,
  });

export const catalogueRoute = new Elysia()
  .use(sessionCatalogueRoute)
  .use(authenticatedCatalogueRoute);
