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
import { routes } from "@/api/http/route";

/**
 * Machine (CI / agent / CLI) API key lifecycle.
 *
 * The plugin's own `/api-key/*` HTTP routes are in `disabledPaths` (see
 * `lib/auth.ts`): they authorize on "is this your key" alone, with no org-admin
 * check, no subset validation against the caller's role, and no audit record.
 * This is the only route surface that mints or revokes a machine credential.
 */
export const apiKeysRoute = routes(
  {
    "/current": { GET: currentMachineApiKey },
    "/personal": { GET: listPersonalKeys, POST: createPersonalKey },
    "/personal/rotate": { POST: rotatePersonalKey },
    "/personal/revoke": { POST: revokePersonalKey },
    "/personal/organization": { GET: listOrganizationPersonalKeys },
    "/personal/organization/revoke": { POST: revokeOrganizationPersonalKey },
    "/personal/policy": { POST: updatePersonalKeyPolicy },
    "/": { GET: listMachineApiKeys, POST: createMachineApiKey },
    "/rotate": { POST: rotateMachineApiKey },
    "/revoke": { POST: revokeMachineApiKey },
  },
  { prefix: "/api-keys" },
);
