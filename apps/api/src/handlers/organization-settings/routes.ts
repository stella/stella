import Elysia from "elysia";

import {
  previewOrganizationSettingsBodySchema,
  previewOrganizationSettingsHandler,
} from "@/api/handlers/organization-settings/preview";
import readOrganizationSettings from "@/api/handlers/organization-settings/read";
import updateOrganizationSettings from "@/api/handlers/organization-settings/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const organizationSettingsRoute = new Elysia({
  prefix: "/organization-settings",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get("/", readOrganizationSettings.handler)
  .post("/", updateOrganizationSettings.handler, {
    body: updateOrganizationSettings.config.body,
  })
  .post(
    "/preview",
    async (ctx) =>
      await previewOrganizationSettingsHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { organizationSettings: ["update"] },
      body: previewOrganizationSettingsBodySchema,
    },
  );
