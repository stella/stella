import Elysia from "elysia";

import clearSearchHistory from "@/api/handlers/search-history/clear";
import deleteSearchHistoryEntry from "@/api/handlers/search-history/delete";
import importSearchHistory from "@/api/handlers/search-history/import";
import importClock from "@/api/handlers/search-history/import-clock";
import listSearchHistory from "@/api/handlers/search-history/list";
import upsertSearchHistory from "@/api/handlers/search-history/upsert";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const searchHistoryRoute = new Elysia({ prefix: "/search-history" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      query: listSearchHistory.config.query,
      permissions: listSearchHistory.config.permissions,
    },
    listSearchHistory.handler,
  )
  .post(
    "/",
    {
      body: upsertSearchHistory.config.body,
      query: upsertSearchHistory.config.query,
      permissions: upsertSearchHistory.config.permissions,
    },
    upsertSearchHistory.handler,
  )
  .get(
    "/import-clock",
    {
      query: importClock.config.query,
      permissions: importClock.config.permissions,
    },
    importClock.handler,
  )
  .post(
    "/import",
    {
      body: importSearchHistory.config.body,
      query: importSearchHistory.config.query,
      permissions: importSearchHistory.config.permissions,
    },
    importSearchHistory.handler,
  )
  .delete(
    "/",
    {
      query: clearSearchHistory.config.query,
      permissions: clearSearchHistory.config.permissions,
    },
    clearSearchHistory.handler,
  )
  .delete(
    "/:entryId",
    {
      params: deleteSearchHistoryEntry.config.params,
      query: deleteSearchHistoryEntry.config.query,
      permissions: deleteSearchHistoryEntry.config.permissions,
    },
    deleteSearchHistoryEntry.handler,
  );
