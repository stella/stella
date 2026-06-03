import Elysia from "elysia";

// Deprecated: prompt shortcuts have been folded into `agent_skills`.
// The data migration in
// `20260602120000_agent_skills_command_autoinvoke` copies every
// shortcut row into a slash-command-bearing skill. The read route
// stays mounted for one release so old clients can keep listing
// their prompts; writes (create / seed / update / delete) are
// disabled so a stale tab can't diverge the two stores — any write
// from an old client would never reach `agent_skills`, and a delete
// would leave the migrated skill behind, both of which surfaced as
// "lost or resurrected" prompts in the unified chat menu. Old
// clients hitting a write get a 410 from the missing route and the
// user reloads into the new surface. Follow-up cleanup PR removes
// the GET and drops the `prompt_shortcuts` table.
import listShortcuts from "@/api/handlers/shortcuts/list";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const shortcutsRoute = new Elysia({ prefix: "/shortcuts" })
  .use(authMacro)
  .use(permissionMacro)
  .use(invalidateQuery)
  .guard({ validateAuth: true })
  .get("/", listShortcuts.handler, {
    permissions: listShortcuts.config.permissions,
  });
