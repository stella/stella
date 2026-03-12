import Elysia from "elysia";

import {
  previewOrganizationSettingsBodySchema,
  previewOrganizationSettingsHandler,
} from "@/api/handlers/organization-settings/preview";
import { readOrganizationSettingsHandler } from "@/api/handlers/organization-settings/read";
import {
  updateOrganizationSettingsBodySchema,
  updateOrganizationSettingsHandler,
} from "@/api/handlers/organization-settings/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const organizationSettingsRoute = new Elysia({
  prefix: "/organization-settings",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get(
    "/",
    async (ctx) =>
      await readOrganizationSettingsHandler({
        organizationId: ctx.session.activeOrganizationId,
        scopedDb: ctx.scopedDb,
      }),
  )
  .post(
    "/",
    async (ctx) =>
      await updateOrganizationSettingsHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { organizationSettings: ["update"] },
      body: updateOrganizationSettingsBodySchema,
    },
  )
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
