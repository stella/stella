import Elysia from "elysia";

import createBilingualRun from "@/api/handlers/bilingual-translations/create-run";
import prepareBilingualTranslation from "@/api/handlers/bilingual-translations/prepare";
import readBilingualRun from "@/api/handlers/bilingual-translations/read-run";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const bilingualTranslationsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/bilingual-translations",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post(
    "/prepare",
    {
      body: prepareBilingualTranslation.config.body,
      params: prepareBilingualTranslation.config.params,
      permissions: prepareBilingualTranslation.config.permissions,
    },
    prepareBilingualTranslation.handler,
  )
  .post(
    "/runs",
    {
      body: createBilingualRun.config.body,
      params: createBilingualRun.config.params,
      permissions: createBilingualRun.config.permissions,
    },
    createBilingualRun.handler,
  )
  .get(
    "/runs/:runId",
    {
      params: readBilingualRun.config.params,
      permissions: readBilingualRun.config.permissions,
    },
    readBilingualRun.handler,
  );
