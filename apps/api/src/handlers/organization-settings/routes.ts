import Elysia from "elysia";

import deleteAIConfig from "@/api/handlers/organization-settings/delete-ai-config";
import previewOrganizationSettings from "@/api/handlers/organization-settings/preview";
import readOrganizationSettings from "@/api/handlers/organization-settings/read";
import readAIAvailability from "@/api/handlers/organization-settings/read-ai-availability";
import readAIConfig from "@/api/handlers/organization-settings/read-ai-config";
import readAnonymizationBlacklist from "@/api/handlers/organization-settings/read-anonymization-blacklist";
import updateOrganizationSettings from "@/api/handlers/organization-settings/update";
import updateAIConfig from "@/api/handlers/organization-settings/update-ai-config";
import updateAnonymizationBlacklist from "@/api/handlers/organization-settings/update-anonymization-blacklist";
import updatePracticeJurisdictions from "@/api/handlers/organization-settings/update-practice-jurisdictions";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const organizationSettingsRoute = new Elysia({
  prefix: "/organization-settings",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get("/", readOrganizationSettings.handler)
  .post("/", updateOrganizationSettings.handler, {
    body: updateOrganizationSettings.config.body,
  })
  .post("/practice-jurisdictions", updatePracticeJurisdictions.handler, {
    body: updatePracticeJurisdictions.config.body,
    permissions: updatePracticeJurisdictions.config.permissions,
  })
  .post("/preview", previewOrganizationSettings.handler, {
    body: previewOrganizationSettings.config.body,
  })
  .get("/ai-availability", readAIAvailability.handler)
  .get("/ai-config", readAIConfig.handler)
  .post("/ai-config", updateAIConfig.handler, {
    body: updateAIConfig.config.body,
  })
  .delete("/ai-config", deleteAIConfig.handler)
  .get("/anonymization-blacklist", readAnonymizationBlacklist.handler)
  .put("/anonymization-blacklist", updateAnonymizationBlacklist.handler, {
    body: updateAnonymizationBlacklist.config.body,
  });
