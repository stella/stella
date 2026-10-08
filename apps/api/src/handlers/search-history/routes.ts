import Elysia from "elysia";

import clearSearchHistory from "@/api/handlers/search-history/clear";
import deleteSearchHistoryEntry from "@/api/handlers/search-history/delete";
import importSearchHistory from "@/api/handlers/search-history/import";
import listSearchHistory from "@/api/handlers/search-history/list";
import upsertSearchHistory from "@/api/handlers/search-history/upsert";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const searchHistoryRoute = new Elysia({ prefix: "/search-history" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listSearchHistory.handler, {
    query: listSearchHistory.config.query,
    permissions: listSearchHistory.config.permissions,
  })
  .post("/", upsertSearchHistory.handler, {
    body: upsertSearchHistory.config.body,
    query: upsertSearchHistory.config.query,
    permissions: upsertSearchHistory.config.permissions,
  })
  .post("/import", importSearchHistory.handler, {
    body: importSearchHistory.config.body,
    query: importSearchHistory.config.query,
    permissions: importSearchHistory.config.permissions,
  })
  .delete("/", clearSearchHistory.handler, {
    query: clearSearchHistory.config.query,
    permissions: clearSearchHistory.config.permissions,
  })
  .delete("/:entryId", deleteSearchHistoryEntry.handler, {
    params: deleteSearchHistoryEntry.config.params,
    query: deleteSearchHistoryEntry.config.query,
    permissions: deleteSearchHistoryEntry.config.permissions,
  });
