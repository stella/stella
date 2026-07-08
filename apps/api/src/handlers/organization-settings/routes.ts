import Elysia from "elysia";

import deleteAIConfig from "@/api/handlers/organization-settings/delete-ai-config";
import deleteDeepLKey from "@/api/handlers/organization-settings/delete-deepl-key";
import deleteWebSearchKey from "@/api/handlers/organization-settings/delete-web-search-key";
import previewOrganizationSettings from "@/api/handlers/organization-settings/preview";
import readOrganizationSettings from "@/api/handlers/organization-settings/read";
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
  // Deliberately no top-level auth guard: every route below already
  // declares `permissions`, which implies `validateAuth: true` (see
  // permissionMacro in lib/auth.ts). A redundant bare guard here would
  // register a second, independent `validateAuth` resolve hook per
  // request (Elysia doesn't dedupe macro expansions across separate
  // guard / route-level call sites). See
  // tests/security/redundant-validate-auth-guard.test.ts.
  //
  // Each route below also repeats `validateAuth: true` alongside
  // `permissions`. This is a type-only workaround, not a behavioral
  // duplicate: `permissions` is a function-form macro (see "Known Elysia
  // Gotchas" in AGENTS.md), so the `validateAuth: true` it returns
  // internally isn't picked up by Elysia's type-level context composition
  // — only a literal `validateAuth`/`validateWorkspaceAccess` key at the
  // same call site is. Runtime dedup (same call's hook object) and the
  // per-request memoization in `resolveValidateAuth` mean this does not
  // add a second resolve.
  .get("/", readOrganizationSettings.handler, {
    permissions: readOrganizationSettings.config.permissions,
    validateAuth: true,
  })
  .post("/", updateOrganizationSettings.handler, {
    body: updateOrganizationSettings.config.body,
    permissions: updateOrganizationSettings.config.permissions,
    validateAuth: true,
  })
  .post("/practice-jurisdictions", updatePracticeJurisdictions.handler, {
    body: updatePracticeJurisdictions.config.body,
    permissions: updatePracticeJurisdictions.config.permissions,
    validateAuth: true,
  })
  .post("/preview", previewOrganizationSettings.handler, {
    body: previewOrganizationSettings.config.body,
    permissions: previewOrganizationSettings.config.permissions,
    validateAuth: true,
  })
  .get("/ai-availability", readAIAvailability.handler, {
    permissions: readAIAvailability.config.permissions,
    validateAuth: true,
  })
  .get("/ai-config", readAIConfig.handler, {
    permissions: readAIConfig.config.permissions,
    validateAuth: true,
  })
  .post("/ai-config", updateAIConfig.handler, {
    body: updateAIConfig.config.body,
    permissions: updateAIConfig.config.permissions,
    validateAuth: true,
  })
  .delete("/ai-config", deleteAIConfig.handler, {
    permissions: deleteAIConfig.config.permissions,
    validateAuth: true,
  })
  .get("/deepl", readDeepLAvailability.handler, {
    permissions: readDeepLAvailability.config.permissions,
    validateAuth: true,
  })
  .get("/deepl-config", readDeepLConfig.handler, {
    permissions: readDeepLConfig.config.permissions,
    validateAuth: true,
  })
  .post("/deepl", updateDeepLKey.handler, {
    body: updateDeepLKey.config.body,
    permissions: updateDeepLKey.config.permissions,
    validateAuth: true,
  })
  .delete("/deepl", deleteDeepLKey.handler, {
    permissions: deleteDeepLKey.config.permissions,
    validateAuth: true,
  })
  .get("/web-search-config", readWebSearchConfig.handler, {
    permissions: readWebSearchConfig.config.permissions,
    validateAuth: true,
  })
  .post("/web-search-key", updateWebSearchKey.handler, {
    body: updateWebSearchKey.config.body,
    permissions: updateWebSearchKey.config.permissions,
    validateAuth: true,
  })
  .delete("/web-search-key", deleteWebSearchKey.handler, {
    body: deleteWebSearchKey.config.body,
    permissions: deleteWebSearchKey.config.permissions,
    validateAuth: true,
  })
  .get("/anonymization-blacklist", readAnonymizationBlacklist.handler, {
    permissions: readAnonymizationBlacklist.config.permissions,
    validateAuth: true,
  })
  .put("/anonymization-blacklist", updateAnonymizationBlacklist.handler, {
    body: updateAnonymizationBlacklist.config.body,
    permissions: updateAnonymizationBlacklist.config.permissions,
    validateAuth: true,
  });
