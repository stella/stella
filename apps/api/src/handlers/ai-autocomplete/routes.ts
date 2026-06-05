import Elysia from "elysia";

import autocompleteStream from "@/api/handlers/ai-autocomplete/stream";
import { authMacro, permissionMacro } from "@/api/lib/auth";

// Mounted at `/v1/ai-autocomplete` directly at the root rather
// than inside the `.group("/v1", ...)` chain in
// `apps/api/src/index.ts`. Folding one more `.use()` into that
// group tips Elysia's already-substantial inferred type past
// TypeScript's complexity threshold and ripples `implicit any`
// errors onto the surrounding `onError` / `onAfterHandle`
// handler parameters. Mounting at the root keeps the inference
// shallow and matches the same pattern `mcpRoute` already uses.
export const aiAutocompleteRoute = new Elysia({
  prefix: "/v1/ai-autocomplete",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/stream", autocompleteStream.handler, {
    body: autocompleteStream.config.body,
    permissions: autocompleteStream.config.permissions,
  });
