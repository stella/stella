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
  .post("/prepare", prepareBilingualTranslation.handler, {
    body: prepareBilingualTranslation.config.body,
    params: prepareBilingualTranslation.config.params,
    permissions: prepareBilingualTranslation.config.permissions,
  })
  .post("/runs", createBilingualRun.handler, {
    body: createBilingualRun.config.body,
    params: createBilingualRun.config.params,
    permissions: createBilingualRun.config.permissions,
  })
  .get("/runs/:runId", readBilingualRun.handler, {
    params: readBilingualRun.config.params,
    permissions: readBilingualRun.config.permissions,
  });
