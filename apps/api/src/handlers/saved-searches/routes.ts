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
  .get(
    "/",
    {
      query: listSavedSearches.config.query,
      permissions: listSavedSearches.config.permissions,
    },
    listSavedSearches.handler,
  )
  .post(
    "/",
    {
      body: createSavedSearch.config.body,
      permissions: createSavedSearch.config.permissions,
    },
    createSavedSearch.handler,
  )
  .patch(
    "/:savedSearchId",
    {
      body: updateSavedSearch.config.body,
      params: updateSavedSearch.config.params,
      permissions: updateSavedSearch.config.permissions,
    },
    updateSavedSearch.handler,
  )
  .delete(
    "/:savedSearchId",
    {
      params: deleteSavedSearch.config.params,
      permissions: deleteSavedSearch.config.permissions,
    },
    deleteSavedSearch.handler,
  );
