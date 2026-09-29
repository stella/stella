import Elysia from "elysia";

import createSavedTimeNarrative from "@/api/handlers/saved-time-narratives/create";
import deleteSavedTimeNarrative from "@/api/handlers/saved-time-narratives/delete";
import listSavedTimeNarratives from "@/api/handlers/saved-time-narratives/list";
import updateSavedTimeNarrative from "@/api/handlers/saved-time-narratives/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const savedTimeNarrativesRoute = new Elysia({
  prefix: "/saved-time-narratives",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listSavedTimeNarratives.handler, {
    query: listSavedTimeNarratives.config.query,
    permissions: listSavedTimeNarratives.config.permissions,
  })
  .post("/", createSavedTimeNarrative.handler, {
    body: createSavedTimeNarrative.config.body,
    permissions: createSavedTimeNarrative.config.permissions,
  })
  .patch("/:id", updateSavedTimeNarrative.handler, {
    params: updateSavedTimeNarrative.config.params,
    body: updateSavedTimeNarrative.config.body,
    permissions: updateSavedTimeNarrative.config.permissions,
  })
  .delete("/:id", deleteSavedTimeNarrative.handler, {
    params: deleteSavedTimeNarrative.config.params,
    permissions: deleteSavedTimeNarrative.config.permissions,
  });
