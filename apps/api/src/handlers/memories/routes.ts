import Elysia from "elysia";

import createMemory from "@/api/handlers/memories/create";
import createFirmMemory from "@/api/handlers/memories/create-firm";
import listMemories from "@/api/handlers/memories/list";
import updateMemory from "@/api/handlers/memories/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

// Mounted at `/v1/memories` directly at the root rather than inside
// the `.group("/v1", ...)` chain in `apps/api/src/index.ts`, matching
// `aiAutocompleteRoute` / `mcpRoute`: folding another `.use()` into
// that group tips Elysia's inferred type past TypeScript's complexity
// threshold. Firm-scoped writes live under `/firm` with their own
// `firmMemory` permission; user/matter writes use the base path.
export const memoriesRoute = new Elysia({
  prefix: "/v1/memories",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listMemories.handler, {
    query: listMemories.config.query,
    permissions: listMemories.config.permissions,
  })
  .post("/", createMemory.handler, {
    body: createMemory.config.body,
    permissions: createMemory.config.permissions,
  })
  .post("/firm", createFirmMemory.handler, {
    body: createFirmMemory.config.body,
    permissions: createFirmMemory.config.permissions,
  })
  .patch("/:memoryId", updateMemory.handler, {
    body: updateMemory.config.body,
    params: updateMemory.config.params,
    permissions: updateMemory.config.permissions,
  });
