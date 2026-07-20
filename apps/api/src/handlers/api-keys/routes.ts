import Elysia from "elysia";

import createMachineApiKey from "@/api/handlers/api-keys/create";
import listMachineApiKeys from "@/api/handlers/api-keys/list";
import revokeMachineApiKey from "@/api/handlers/api-keys/revoke";
import rotateMachineApiKey from "@/api/handlers/api-keys/rotate";
import { authMacro, permissionMacro } from "@/api/lib/auth";

/**
 * Machine (CI / agent / CLI) API key lifecycle.
 *
 * The plugin's own `/api-key/*` HTTP routes are in `disabledPaths` (see
 * `lib/auth.ts`): they authorize on "is this your key" alone, with no org-admin
 * check, no subset validation against the caller's role, and no audit record.
 * This is the only route surface that mints or revokes a machine credential.
 */
export const apiKeysRoute = new Elysia({ prefix: "/api-keys" })
  .use(authMacro)
  .use(permissionMacro)
  // See the identical guard in `organization-settings/routes.ts` for why this
  // stays even though `permissions` already applies `validateAuth` at runtime.
  .guard({
    validateAuth: true,
  })
  .get("/", listMachineApiKeys.handler, {
    permissions: listMachineApiKeys.config.permissions,
  })
  .post("/", createMachineApiKey.handler, {
    body: createMachineApiKey.config.body,
    permissions: createMachineApiKey.config.permissions,
  })
  .post("/rotate", rotateMachineApiKey.handler, {
    body: rotateMachineApiKey.config.body,
    permissions: rotateMachineApiKey.config.permissions,
  })
  .post("/revoke", revokeMachineApiKey.handler, {
    body: revokeMachineApiKey.config.body,
    permissions: revokeMachineApiKey.config.permissions,
  });
