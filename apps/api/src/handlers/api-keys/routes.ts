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
  .get(
    "/personal",
    {
      query: listPersonalKeys.config.query,
      permissions: listPersonalKeys.config.permissions,
    },
    listPersonalKeys.handler,
  )
  .post(
    "/personal",
    {
      body: createPersonalKey.config.body,
      permissions: createPersonalKey.config.permissions,
    },
    createPersonalKey.handler,
  )
  .post(
    "/personal/rotate",
    {
      body: rotatePersonalKey.config.body,
      permissions: rotatePersonalKey.config.permissions,
    },
    rotatePersonalKey.handler,
  )
  .post(
    "/personal/revoke",
    {
      body: revokePersonalKey.config.body,
      permissions: revokePersonalKey.config.permissions,
    },
    revokePersonalKey.handler,
  )
  .get(
    "/personal/organization",
    {
      query: listOrganizationPersonalKeys.config.query,
      permissions: listOrganizationPersonalKeys.config.permissions,
    },
    listOrganizationPersonalKeys.handler,
  )
  .post(
    "/personal/organization/revoke",
    {
      body: revokeOrganizationPersonalKey.config.body,
      permissions: revokeOrganizationPersonalKey.config.permissions,
    },
    revokeOrganizationPersonalKey.handler,
  )
  .post(
    "/personal/policy",
    {
      body: updatePersonalKeyPolicy.config.body,
      permissions: updatePersonalKeyPolicy.config.permissions,
    },
    updatePersonalKeyPolicy.handler,
  )
  .get(
    "/",
    {
      query: listMachineApiKeys.config.query,
      permissions: listMachineApiKeys.config.permissions,
    },
    listMachineApiKeys.handler,
  )
  .post(
    "/",
    {
      body: createMachineApiKey.config.body,
      permissions: createMachineApiKey.config.permissions,
    },
    createMachineApiKey.handler,
  )
  .post(
    "/rotate",
    {
      body: rotateMachineApiKey.config.body,
      permissions: rotateMachineApiKey.config.permissions,
    },
    rotateMachineApiKey.handler,
  )
  .post(
    "/revoke",
    {
      body: revokeMachineApiKey.config.body,
      permissions: revokeMachineApiKey.config.permissions,
    },
    revokeMachineApiKey.handler,
  );
