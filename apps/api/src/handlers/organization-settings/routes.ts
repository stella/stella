import Elysia from "elysia";

import deleteAIConfig from "@/api/handlers/organization-settings/delete-ai-config";
import deleteDeepLKey from "@/api/handlers/organization-settings/delete-deepl-key";
import previewOrganizationSettings from "@/api/handlers/organization-settings/preview";
import readOrganizationSettings from "@/api/handlers/organization-settings/read";
import readAIAvailability from "@/api/handlers/organization-settings/read-ai-availability";
import readAIConfig from "@/api/handlers/organization-settings/read-ai-config";
import readAnonymizationBlacklist from "@/api/handlers/organization-settings/read-anonymization-blacklist";
import readDeepLAvailability from "@/api/handlers/organization-settings/read-deepl-availability";
import updateOrganizationSettings from "@/api/handlers/organization-settings/update";
import updateAIConfig from "@/api/handlers/organization-settings/update-ai-config";
import updateAnonymizationBlacklist from "@/api/handlers/organization-settings/update-anonymization-blacklist";
import updateDeepLKey from "@/api/handlers/organization-settings/update-deepl-key";
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
  .get("/", readOrganizationSettings.handler, {
    permissions: readOrganizationSettings.config.permissions,
  })
  .post("/", updateOrganizationSettings.handler, {
    body: updateOrganizationSettings.config.body,
    permissions: updateOrganizationSettings.config.permissions,
  })
  .post("/practice-jurisdictions", updatePracticeJurisdictions.handler, {
    body: updatePracticeJurisdictions.config.body,
    permissions: updatePracticeJurisdictions.config.permissions,
  })
  .post("/preview", previewOrganizationSettings.handler, {
    body: previewOrganizationSettings.config.body,
    permissions: previewOrganizationSettings.config.permissions,
  })
  .get("/ai-availability", readAIAvailability.handler, {
    permissions: readAIAvailability.config.permissions,
  })
  .get("/ai-config", readAIConfig.handler, {
    permissions: readAIConfig.config.permissions,
  })
  .post("/ai-config", updateAIConfig.handler, {
    body: updateAIConfig.config.body,
    permissions: updateAIConfig.config.permissions,
  })
  .delete("/ai-config", deleteAIConfig.handler, {
    permissions: deleteAIConfig.config.permissions,
  })
  .get("/deepl", readDeepLAvailability.handler, {
    permissions: readDeepLAvailability.config.permissions,
  })
  .post("/deepl", updateDeepLKey.handler, {
    body: updateDeepLKey.config.body,
    permissions: updateDeepLKey.config.permissions,
  })
  .delete("/deepl", deleteDeepLKey.handler, {
    permissions: deleteDeepLKey.config.permissions,
  })
  .get("/anonymization-blacklist", readAnonymizationBlacklist.handler, {
    permissions: readAnonymizationBlacklist.config.permissions,
  })
  .put("/anonymization-blacklist", updateAnonymizationBlacklist.handler, {
    body: updateAnonymizationBlacklist.config.body,
    permissions: updateAnonymizationBlacklist.config.permissions,
  });
