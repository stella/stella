import Elysia from "elysia";

import createMachineApiKey from "@/api/handlers/api-keys/create";
import currentMachineApiKey from "@/api/handlers/api-keys/current";
import listMachineApiKeys from "@/api/handlers/api-keys/list";
import createPersonalKey from "@/api/handlers/api-keys/personal/create";
import listPersonalKeys from "@/api/handlers/api-keys/personal/list";
import listOrganizationPersonalKeys from "@/api/handlers/api-keys/personal/list-organization";
import updatePersonalKeyPolicy from "@/api/handlers/api-keys/personal/policy";
import revokePersonalKey from "@/api/handlers/api-keys/personal/revoke";
import revokeOrganizationPersonalKey from "@/api/handlers/api-keys/personal/revoke-organization";
import rotatePersonalKey from "@/api/handlers/api-keys/personal/rotate";
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
  .get("/current", currentMachineApiKey.handler)
  .use(authMacro)
  .use(permissionMacro)
  // See the identical guard in `organization-settings/routes.ts` for why this
  // stays even though `permissions` already applies `validateAuth` at runtime.
  .guard({
    validateAuth: true,
  })
  .get("/personal", listPersonalKeys.handler, {
    query: listPersonalKeys.config.query,
    permissions: listPersonalKeys.config.permissions,
  })
  .post("/personal", createPersonalKey.handler, {
    body: createPersonalKey.config.body,
    permissions: createPersonalKey.config.permissions,
  })
  .post("/personal/rotate", rotatePersonalKey.handler, {
    body: rotatePersonalKey.config.body,
    permissions: rotatePersonalKey.config.permissions,
  })
  .post("/personal/revoke", revokePersonalKey.handler, {
    body: revokePersonalKey.config.body,
    permissions: revokePersonalKey.config.permissions,
  })
  .get("/personal/organization", listOrganizationPersonalKeys.handler, {
    query: listOrganizationPersonalKeys.config.query,
    permissions: listOrganizationPersonalKeys.config.permissions,
  })
  .post(
    "/personal/organization/revoke",
    revokeOrganizationPersonalKey.handler,
    {
      body: revokeOrganizationPersonalKey.config.body,
      permissions: revokeOrganizationPersonalKey.config.permissions,
    },
  )
  .post("/personal/policy", updatePersonalKeyPolicy.handler, {
    body: updatePersonalKeyPolicy.config.body,
    permissions: updatePersonalKeyPolicy.config.permissions,
  })
  .get("/", listMachineApiKeys.handler, {
    query: listMachineApiKeys.config.query,
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
