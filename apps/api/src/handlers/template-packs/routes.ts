import Elysia from "elysia";

import { env } from "@/api/env";
import getTemplatePack from "@/api/handlers/template-packs/get";
import installTemplatePack from "@/api/handlers/template-packs/installs/create";
import listTemplatePacks from "@/api/handlers/template-packs/list";
import updateTemplatePackVisibility from "@/api/handlers/template-packs/visibility/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const templatePacksRoute = new Elysia({ prefix: "/template-packs" })
  // Deployment gate: a deployment that does not offer bundled packs has no
  // such routes at all, like the public-law routes.
  .onBeforeHandle(({ set }) => {
    if (env.FEATURE_TEMPLATE_PACKS) {
      return undefined;
    }

    set.status = 404;
    return { error: "Not Found" } as const;
  })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listTemplatePacks.handler, {
    permissions: listTemplatePacks.config.permissions,
    query: listTemplatePacks.config.query,
  })
  .post("/visibility", updateTemplatePackVisibility.handler, {
    body: updateTemplatePackVisibility.config.body,
    permissions: updateTemplatePackVisibility.config.permissions,
  })
  .get("/:packId", getTemplatePack.handler, {
    params: getTemplatePack.config.params,
    permissions: getTemplatePack.config.permissions,
    query: getTemplatePack.config.query,
  })
  .post("/:packId/install", installTemplatePack.handler, {
    body: installTemplatePack.config.body,
    params: installTemplatePack.config.params,
    permissions: installTemplatePack.config.permissions,
  });
