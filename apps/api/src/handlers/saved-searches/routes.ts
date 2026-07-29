import Elysia from "elysia";

import createSavedSearch from "@/api/handlers/saved-searches/create";
import deleteSavedSearch from "@/api/handlers/saved-searches/delete";
import listSavedSearches from "@/api/handlers/saved-searches/list";
import updateSavedSearch from "@/api/handlers/saved-searches/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const savedSearchesRoute = new Elysia({ prefix: "/saved-searches" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listSavedSearches.handler, {
    query: listSavedSearches.config.query,
    permissions: listSavedSearches.config.permissions,
  })
  .post("/", createSavedSearch.handler, {
    body: createSavedSearch.config.body,
    permissions: createSavedSearch.config.permissions,
  })
  .patch("/:savedSearchId", updateSavedSearch.handler, {
    body: updateSavedSearch.config.body,
    params: updateSavedSearch.config.params,
    permissions: updateSavedSearch.config.permissions,
  })
  .delete("/:savedSearchId", deleteSavedSearch.handler, {
    params: deleteSavedSearch.config.params,
    permissions: deleteSavedSearch.config.permissions,
  });
