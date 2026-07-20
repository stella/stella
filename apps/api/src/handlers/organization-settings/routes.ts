import Elysia from "elysia";

import deleteAIConfig from "@/api/handlers/organization-settings/delete-ai-config";
import deleteDeepLKey from "@/api/handlers/organization-settings/delete-deepl-key";
import deleteWebSearchKey from "@/api/handlers/organization-settings/delete-web-search-key";
import readOrganizationSettings from "@/api/handlers/organization-settings/get";
import previewOrganizationSettings from "@/api/handlers/organization-settings/preview";
import readAIAvailability from "@/api/handlers/organization-settings/read-ai-availability";
import readAIConfig from "@/api/handlers/organization-settings/read-ai-config";
import readAnonymizationBlacklist from "@/api/handlers/organization-settings/read-anonymization-blacklist";
import readDeepLAvailability from "@/api/handlers/organization-settings/read-deepl-availability";
import readDeepLConfig from "@/api/handlers/organization-settings/read-deepl-config";
import readWebSearchConfig from "@/api/handlers/organization-settings/read-web-search-config";
import updateOrganizationSettings from "@/api/handlers/organization-settings/update";
import updateAIConfig from "@/api/handlers/organization-settings/update-ai-config";
import updateAnonymizationBlacklist from "@/api/handlers/organization-settings/update-anonymization-blacklist";
import updateDeepLKey from "@/api/handlers/organization-settings/update-deepl-key";
import updatePracticeJurisdictions from "@/api/handlers/organization-settings/update-practice-jurisdictions";
import updateWebSearchKey from "@/api/handlers/organization-settings/update-web-search-key";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const organizationSettingsRoute = new Elysia({
  prefix: "/organization-settings",
})
  .use(authMacro)
  .use(permissionMacro)
  // Kept deliberately: this guard is the type-level carrier of
  // `validateAuth` for Elysia's context composition. `permissions` is a
  // function-form macro (see "Known Elysia Gotchas" in AGENTS.md) that
  // applies `validateAuth` at runtime but not in type composition, so a
  // per-route `validateAuth: true` literal instead of this guard breaks
  // sibling macros' schema merging (e.g. `invalidateQuery`'s body
  // extension). The per-request memoization in `resolveValidateAuth`
  // (lib/auth.ts) neutralizes the extra resolve this guard stacks on top
  // of `permissions`. See tests/security/route-auth-invariants.test.ts.
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
  .get("/deepl-config", readDeepLConfig.handler, {
    permissions: readDeepLConfig.config.permissions,
  })
  .post("/deepl", updateDeepLKey.handler, {
    body: updateDeepLKey.config.body,
    permissions: updateDeepLKey.config.permissions,
  })
  .delete("/deepl", deleteDeepLKey.handler, {
    permissions: deleteDeepLKey.config.permissions,
  })
  .get("/web-search-config", readWebSearchConfig.handler, {
    permissions: readWebSearchConfig.config.permissions,
  })
  .post("/web-search-key", updateWebSearchKey.handler, {
    body: updateWebSearchKey.config.body,
    permissions: updateWebSearchKey.config.permissions,
  })
  .delete("/web-search-key", deleteWebSearchKey.handler, {
    body: deleteWebSearchKey.config.body,
    permissions: deleteWebSearchKey.config.permissions,
  })
  .get("/anonymization-blacklist", readAnonymizationBlacklist.handler, {
    permissions: readAnonymizationBlacklist.config.permissions,
  })
  .put("/anonymization-blacklist", updateAnonymizationBlacklist.handler, {
    body: updateAnonymizationBlacklist.config.body,
    permissions: updateAnonymizationBlacklist.config.permissions,
  });
