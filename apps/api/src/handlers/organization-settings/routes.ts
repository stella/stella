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
import { authMacro } from "@/api/lib/auth";

export const organizationSettingsRoute = new Elysia({
  prefix: "/organization-settings",
})
  .use(authMacro)
  .guard({
    validateAuth: true,
  })
  .get("/", (ctx) =>
    readOrganizationSettingsHandler({
      organizationId: ctx.session.activeOrganizationId,
    }),
  )
  .post(
    "/",
    (ctx) =>
      updateOrganizationSettingsHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    {
      body: updateOrganizationSettingsBodySchema,
    },
  )
  .post(
    "/preview",
    (ctx) =>
      previewOrganizationSettingsHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    {
      body: previewOrganizationSettingsBodySchema,
    },
  );
