import Elysia from "elysia";

// Deprecated: prompt shortcuts have been folded into `agent_skills`.
// The data migration in
// `20260602120000_agent_skills_command_autoinvoke` copies every
// shortcut row into a slash-command-bearing skill. These routes
// remain mounted for one release so old clients can keep reading
// their prompts; new clients should hit `/skills` instead. Follow-up
// cleanup PR will remove the routes and drop the `prompt_shortcuts`
// table.
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
  .get("/", listShortcuts.handler, {
    permissions: listShortcuts.config.permissions,
  })
  .put("/", createShortcut.handler, {
    body: createShortcut.config.body,
    invalidateQuery: true,
    permissions: createShortcut.config.permissions,
  })
  .post("/seed", seedShortcuts.handler, {
    invalidateQuery: true,
    permissions: seedShortcuts.config.permissions,
  })
  .post("/:shortcutId", updateShortcut.handler, {
    body: updateShortcut.config.body,
    invalidateQuery: true,
    params: updateShortcut.config.params,
    permissions: updateShortcut.config.permissions,
  })
  .delete("/:shortcutId", deleteShortcut.handler, {
    invalidateQuery: true,
    params: deleteShortcut.config.params,
    permissions: deleteShortcut.config.permissions,
  });
