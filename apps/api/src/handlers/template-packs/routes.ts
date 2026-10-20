import Elysia from "elysia";

import getTemplatePack from "@/api/handlers/template-packs/get";
import installTemplatePack from "@/api/handlers/template-packs/installs/create";
import listTemplatePacks from "@/api/handlers/template-packs/list";
import updateTemplatePackVisibility from "@/api/handlers/template-packs/visibility/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

export const templatePacksRoute = new Elysia({ prefix: "/template-packs" })
  // Deployment gate: a deployment that does not offer bundled packs has no
  // such routes at all, like the public-law routes.
  .onBeforeHandle(({ set }) => {
    if (isDeploymentFeatureEnabled("FEATURE_TEMPLATE_PACKS")) {
      return undefined;
    }

    set.status = 404;
    return { error: "Not Found" } as const;
  })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      permissions: listTemplatePacks.config.permissions,
      query: listTemplatePacks.config.query,
    },
    listTemplatePacks.handler,
  )
  .post(
    "/visibility",
    {
      body: updateTemplatePackVisibility.config.body,
      permissions: updateTemplatePackVisibility.config.permissions,
    },
    updateTemplatePackVisibility.handler,
  )
  .get(
    "/:packId",
    {
      params: getTemplatePack.config.params,
      permissions: getTemplatePack.config.permissions,
      query: getTemplatePack.config.query,
    },
    getTemplatePack.handler,
  )
  .post(
    "/:packId/install",
    {
      body: installTemplatePack.config.body,
      params: installTemplatePack.config.params,
      permissions: installTemplatePack.config.permissions,
    },
    installTemplatePack.handler,
  );
