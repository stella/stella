import Elysia from "elysia";

import createShortcut from "@/api/handlers/shortcuts/create";
import deleteShortcut from "@/api/handlers/shortcuts/delete";
import listShortcuts from "@/api/handlers/shortcuts/list";
import seedShortcuts from "@/api/handlers/shortcuts/seed";
import updateShortcut from "@/api/handlers/shortcuts/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const shortcutsRoute = new Elysia({ prefix: "/shortcuts" })
  .use(authMacro)
  .use(permissionMacro)
  .use(invalidateQuery)
  .guard({ validateAuth: true })
  .get("/", listShortcuts.handler)
  .put("/", createShortcut.handler, {
    body: createShortcut.config.body,
    invalidateQuery: true,
  })
  .post("/seed", seedShortcuts.handler, {
    invalidateQuery: true,
  })
  .post("/:shortcutId", updateShortcut.handler, {
    params: updateShortcut.config.params,
    body: updateShortcut.config.body,
    invalidateQuery: true,
  })
  .delete("/:shortcutId", deleteShortcut.handler, {
    params: deleteShortcut.config.params,
    invalidateQuery: true,
  });
