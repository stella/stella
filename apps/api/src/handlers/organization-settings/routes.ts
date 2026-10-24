import Elysia from "elysia";

import readAIAvailability from "@/api/handlers/organization-settings/ai-availability/get";
import previewAIConfigDefaults from "@/api/handlers/organization-settings/ai-config/defaults/preview";
import readAnonymizationBlacklist from "@/api/handlers/organization-settings/anonymization-blacklist/get";
import updateAnonymizationBlacklist from "@/api/handlers/organization-settings/anonymization-blacklist/update";
import {
  deleteBusinessRegistryCredential,
  readBusinessRegistryCredentials,
  saveBusinessRegistryCredential,
} from "@/api/handlers/organization-settings/business-registry-credentials";
import createCorrespondenceAllowedSender from "@/api/handlers/organization-settings/correspondence/allowed-senders/create";
import deleteCorrespondenceAllowedSender from "@/api/handlers/organization-settings/correspondence/allowed-senders/delete";
import listCorrespondenceAllowedSenders from "@/api/handlers/organization-settings/correspondence/allowed-senders/list";
import addCorrespondenceAllowedSenderScope from "@/api/handlers/organization-settings/correspondence/allowed-senders/scope/add";
import removeCorrespondenceAllowedSenderScope from "@/api/handlers/organization-settings/correspondence/allowed-senders/scope/remove";
import addOrganizationDataBox from "@/api/handlers/organization-settings/correspondence/data-boxes/create";
import removeOrganizationDataBox from "@/api/handlers/organization-settings/correspondence/data-boxes/delete";
import getOrganizationDataBoxes from "@/api/handlers/organization-settings/correspondence/data-boxes/get";
import readDeepLAvailability from "@/api/handlers/organization-settings/deepl-availability/get";
import deleteAIConfig from "@/api/handlers/organization-settings/delete-ai-config";
import deleteDeepLKey from "@/api/handlers/organization-settings/delete-deepl-key";
import deleteWebSearchKey from "@/api/handlers/organization-settings/delete-web-search-key";
import getDocumentOcrAvailability from "@/api/handlers/organization-settings/document-ocr-availability/get";
import getFeatureAccess from "@/api/handlers/organization-settings/feature-access/get";
import enrolFeature from "@/api/handlers/organization-settings/feature-enrolments/enrol";
import getFeatureEnrolments from "@/api/handlers/organization-settings/feature-enrolments/get";
import unenrolFeature from "@/api/handlers/organization-settings/feature-enrolments/unenrol";
import readOrganizationSettings from "@/api/handlers/organization-settings/get";
import updatePracticeJurisdictions from "@/api/handlers/organization-settings/practice-jurisdictions/update";
import previewOrganizationSettings from "@/api/handlers/organization-settings/preview";
import readAIConfig from "@/api/handlers/organization-settings/read-ai-config";
import readDeepLConfig from "@/api/handlers/organization-settings/read-deepl-config";
import readWebSearchConfig from "@/api/handlers/organization-settings/read-web-search-config";
import updateSanctionsMonitoring from "@/api/handlers/organization-settings/sanctions-monitoring/update";
import updateOrganizationSettings from "@/api/handlers/organization-settings/update";
import updateAIConfig from "@/api/handlers/organization-settings/update-ai-config";
import updateDeepLKey from "@/api/handlers/organization-settings/update-deepl-key";
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
  // sibling macro context composition. The per-request memoization in
  // `resolveValidateAuth`
  // (lib/auth.ts) neutralizes the extra resolve this guard stacks on top
  // of `permissions`. See tests/security/route-auth-invariants.test.ts.
  .guard({
    validateAuth: true,
  })
  .get("/correspondence/data-boxes", getOrganizationDataBoxes.handler, {
    permissions: getOrganizationDataBoxes.config.permissions,
    accountAccess: getOrganizationDataBoxes.config.accountAccess,
  })
  .post("/correspondence/data-boxes", addOrganizationDataBox.handler, {
    permissions: addOrganizationDataBox.config.permissions,
    accountAccess: addOrganizationDataBox.config.accountAccess,
    body: addOrganizationDataBox.config.body,
  })
  .delete(
    "/correspondence/data-boxes/:boxId",
    removeOrganizationDataBox.handler,
    {
      permissions: removeOrganizationDataBox.config.permissions,
      accountAccess: removeOrganizationDataBox.config.accountAccess,
      params: removeOrganizationDataBox.config.params,
    },
  )
  .get(
    "/correspondence/allowed-senders",
    listCorrespondenceAllowedSenders.handler,
    {
      permissions: listCorrespondenceAllowedSenders.config.permissions,
      accountAccess: listCorrespondenceAllowedSenders.config.accountAccess,
      query: listCorrespondenceAllowedSenders.config.query,
    },
  )
  .post(
    "/correspondence/allowed-senders",
    createCorrespondenceAllowedSender.handler,
    {
      permissions: createCorrespondenceAllowedSender.config.permissions,
      accountAccess: createCorrespondenceAllowedSender.config.accountAccess,
      body: createCorrespondenceAllowedSender.config.body,
    },
  )
  .delete(
    "/correspondence/allowed-senders/:senderId",
    deleteCorrespondenceAllowedSender.handler,
    {
      permissions: deleteCorrespondenceAllowedSender.config.permissions,
      accountAccess: deleteCorrespondenceAllowedSender.config.accountAccess,
      params: deleteCorrespondenceAllowedSender.config.params,
    },
  )
  .post(
    "/correspondence/allowed-senders/:senderId/scope",
    addCorrespondenceAllowedSenderScope.handler,
    {
      permissions: addCorrespondenceAllowedSenderScope.config.permissions,
      accountAccess: addCorrespondenceAllowedSenderScope.config.accountAccess,
      params: addCorrespondenceAllowedSenderScope.config.params,
      body: addCorrespondenceAllowedSenderScope.config.body,
    },
  )
  .delete(
    "/correspondence/allowed-senders/:senderId/scope",
    removeCorrespondenceAllowedSenderScope.handler,
    {
      permissions: removeCorrespondenceAllowedSenderScope.config.permissions,
      accountAccess:
        removeCorrespondenceAllowedSenderScope.config.accountAccess,
      params: removeCorrespondenceAllowedSenderScope.config.params,
      body: removeCorrespondenceAllowedSenderScope.config.body,
    },
  )
  .get("/", readOrganizationSettings.handler, {
    permissions: readOrganizationSettings.config.permissions,
    accountAccess: readOrganizationSettings.config.accountAccess,
  })
  .get(
    "/business-registry-credentials",
    readBusinessRegistryCredentials.handler,
    {
      permissions: readBusinessRegistryCredentials.config.permissions,
      accountAccess: readBusinessRegistryCredentials.config.accountAccess,
    },
  )
  .post(
    "/business-registry-credentials",
    saveBusinessRegistryCredential.handler,
    {
      body: saveBusinessRegistryCredential.config.body,
      permissions: saveBusinessRegistryCredential.config.permissions,
      accountAccess: saveBusinessRegistryCredential.config.accountAccess,
    },
  )
  .delete(
    "/business-registry-credentials",
    deleteBusinessRegistryCredential.handler,
    {
      query: deleteBusinessRegistryCredential.config.query,
      permissions: deleteBusinessRegistryCredential.config.permissions,
      accountAccess: deleteBusinessRegistryCredential.config.accountAccess,
    },
  )
  .post("/", updateOrganizationSettings.handler, {
    body: updateOrganizationSettings.config.body,
    permissions: updateOrganizationSettings.config.permissions,
    accountAccess: updateOrganizationSettings.config.accountAccess,
  })
  .post("/sanctions-monitoring", updateSanctionsMonitoring.handler, {
    permissions: updateSanctionsMonitoring.config.permissions,
    accountAccess: updateSanctionsMonitoring.config.accountAccess,
    body: updateSanctionsMonitoring.config.body,
  })
  .post("/practice-jurisdictions", updatePracticeJurisdictions.handler, {
    body: updatePracticeJurisdictions.config.body,
    permissions: updatePracticeJurisdictions.config.permissions,
    accountAccess: updatePracticeJurisdictions.config.accountAccess,
  })
  .post("/preview", previewOrganizationSettings.handler, {
    body: previewOrganizationSettings.config.body,
    permissions: previewOrganizationSettings.config.permissions,
    accountAccess: previewOrganizationSettings.config.accountAccess,
  })
  .get("/ai-availability", readAIAvailability.handler, {
    permissions: readAIAvailability.config.permissions,
    accountAccess: readAIAvailability.config.accountAccess,
  })
  .get("/feature-enrolments", getFeatureEnrolments.handler, {
    permissions: getFeatureEnrolments.config.permissions,
    accountAccess: getFeatureEnrolments.config.accountAccess,
  })
  .put("/feature-enrolments/:featureId", enrolFeature.handler, {
    permissions: enrolFeature.config.permissions,
    accountAccess: enrolFeature.config.accountAccess,
    params: enrolFeature.config.params,
  })
  .delete("/feature-enrolments/:featureId", unenrolFeature.handler, {
    permissions: unenrolFeature.config.permissions,
    accountAccess: unenrolFeature.config.accountAccess,
    params: unenrolFeature.config.params,
  })
  .get("/feature-access", getFeatureAccess.handler, {
    permissions: getFeatureAccess.config.permissions,
    accountAccess: getFeatureAccess.config.accountAccess,
  })
  .get("/document-ocr-availability", getDocumentOcrAvailability.handler, {
    permissions: getDocumentOcrAvailability.config.permissions,
    accountAccess: getDocumentOcrAvailability.config.accountAccess,
  })
  .post("/ai-config/defaults-preview", previewAIConfigDefaults.handler, {
    body: previewAIConfigDefaults.config.body,
    permissions: previewAIConfigDefaults.config.permissions,
    accountAccess: previewAIConfigDefaults.config.accountAccess,
  })
  .get("/ai-config", readAIConfig.handler, {
    permissions: readAIConfig.config.permissions,
    accountAccess: readAIConfig.config.accountAccess,
  })
  .post("/ai-config", updateAIConfig.handler, {
    body: updateAIConfig.config.body,
    permissions: updateAIConfig.config.permissions,
    accountAccess: updateAIConfig.config.accountAccess,
  })
  .delete("/ai-config", deleteAIConfig.handler, {
    permissions: deleteAIConfig.config.permissions,
    accountAccess: deleteAIConfig.config.accountAccess,
  })
  .get("/deepl", readDeepLAvailability.handler, {
    permissions: readDeepLAvailability.config.permissions,
    accountAccess: readDeepLAvailability.config.accountAccess,
  })
  .get("/deepl-config", readDeepLConfig.handler, {
    permissions: readDeepLConfig.config.permissions,
    accountAccess: readDeepLConfig.config.accountAccess,
  })
  .post("/deepl", updateDeepLKey.handler, {
    body: updateDeepLKey.config.body,
    permissions: updateDeepLKey.config.permissions,
    accountAccess: updateDeepLKey.config.accountAccess,
  })
  .delete("/deepl", deleteDeepLKey.handler, {
    permissions: deleteDeepLKey.config.permissions,
    accountAccess: deleteDeepLKey.config.accountAccess,
  })
  .get("/web-search-config", readWebSearchConfig.handler, {
    permissions: readWebSearchConfig.config.permissions,
    accountAccess: readWebSearchConfig.config.accountAccess,
  })
  .post("/web-search-key", updateWebSearchKey.handler, {
    body: updateWebSearchKey.config.body,
    permissions: updateWebSearchKey.config.permissions,
    accountAccess: updateWebSearchKey.config.accountAccess,
  })
  .delete("/web-search-key", deleteWebSearchKey.handler, {
    body: deleteWebSearchKey.config.body,
    permissions: deleteWebSearchKey.config.permissions,
    accountAccess: deleteWebSearchKey.config.accountAccess,
  })
  .get("/anonymization-blacklist", readAnonymizationBlacklist.handler, {
    permissions: readAnonymizationBlacklist.config.permissions,
    accountAccess: readAnonymizationBlacklist.config.accountAccess,
  })
  .put("/anonymization-blacklist", updateAnonymizationBlacklist.handler, {
    body: updateAnonymizationBlacklist.config.body,
    permissions: updateAnonymizationBlacklist.config.permissions,
    accountAccess: updateAnonymizationBlacklist.config.accountAccess,
  });
