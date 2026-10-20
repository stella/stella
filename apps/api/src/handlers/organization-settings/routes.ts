import Elysia from "elysia";

import readAIAvailability from "@/api/handlers/organization-settings/ai-availability/get";
import previewAIConfigDefaults from "@/api/handlers/organization-settings/ai-config/defaults/preview";
import readAnonymizationBlacklist from "@/api/handlers/organization-settings/anonymization-blacklist/get";
import updateAnonymizationBlacklist from "@/api/handlers/organization-settings/anonymization-blacklist/update";
import {
  readBusinessRegistryCredentials,
  saveBusinessRegistryCredential,
  deleteBusinessRegistryCredential,
} from "@/api/handlers/organization-settings/business-registry-credentials";
import createCorrespondenceAllowedSender from "@/api/handlers/organization-settings/correspondence/allowed-senders/create";
import deleteCorrespondenceAllowedSender from "@/api/handlers/organization-settings/correspondence/allowed-senders/delete";
import listCorrespondenceAllowedSenders from "@/api/handlers/organization-settings/correspondence/allowed-senders/list";
import addCorrespondenceAllowedSenderScope from "@/api/handlers/organization-settings/correspondence/allowed-senders/scope/add";
import removeCorrespondenceAllowedSenderScope from "@/api/handlers/organization-settings/correspondence/allowed-senders/scope/remove";
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
  .get(
    "/correspondence/allowed-senders",
    {
      permissions: listCorrespondenceAllowedSenders.config.permissions,
      query: listCorrespondenceAllowedSenders.config.query,
    },
    listCorrespondenceAllowedSenders.handler,
  )
  .post(
    "/correspondence/allowed-senders",
    {
      permissions: createCorrespondenceAllowedSender.config.permissions,
      body: createCorrespondenceAllowedSender.config.body,
    },
    createCorrespondenceAllowedSender.handler,
  )
  .delete(
    "/correspondence/allowed-senders/:senderId",
    {
      permissions: deleteCorrespondenceAllowedSender.config.permissions,
      params: deleteCorrespondenceAllowedSender.config.params,
    },
    deleteCorrespondenceAllowedSender.handler,
  )
  .post(
    "/correspondence/allowed-senders/:senderId/scope",
    {
      permissions: addCorrespondenceAllowedSenderScope.config.permissions,
      params: addCorrespondenceAllowedSenderScope.config.params,
      body: addCorrespondenceAllowedSenderScope.config.body,
    },
    addCorrespondenceAllowedSenderScope.handler,
  )
  .delete(
    "/correspondence/allowed-senders/:senderId/scope",
    {
      permissions: removeCorrespondenceAllowedSenderScope.config.permissions,
      params: removeCorrespondenceAllowedSenderScope.config.params,
      body: removeCorrespondenceAllowedSenderScope.config.body,
    },
    removeCorrespondenceAllowedSenderScope.handler,
  )
  .get(
    "/",
    {
      permissions: readOrganizationSettings.config.permissions,
    },
    readOrganizationSettings.handler,
  )
  .get(
    "/business-registry-credentials",
    { permissions: readBusinessRegistryCredentials.config.permissions },
    readBusinessRegistryCredentials.handler,
  )
  .post(
    "/business-registry-credentials",
    {
      body: saveBusinessRegistryCredential.config.body,
      permissions: saveBusinessRegistryCredential.config.permissions,
    },
    saveBusinessRegistryCredential.handler,
  )
  .delete(
    "/business-registry-credentials",
    {
      query: deleteBusinessRegistryCredential.config.query,
      permissions: deleteBusinessRegistryCredential.config.permissions,
    },
    deleteBusinessRegistryCredential.handler,
  )
  .post(
    "/",
    {
      body: updateOrganizationSettings.config.body,
      permissions: updateOrganizationSettings.config.permissions,
    },
    updateOrganizationSettings.handler,
  )
  .post(
    "/sanctions-monitoring",
    {
      permissions: updateSanctionsMonitoring.config.permissions,
      body: updateSanctionsMonitoring.config.body,
    },
    updateSanctionsMonitoring.handler,
  )
  .post(
    "/practice-jurisdictions",
    {
      body: updatePracticeJurisdictions.config.body,
      permissions: updatePracticeJurisdictions.config.permissions,
    },
    updatePracticeJurisdictions.handler,
  )
  .post(
    "/preview",
    {
      body: previewOrganizationSettings.config.body,
      permissions: previewOrganizationSettings.config.permissions,
    },
    previewOrganizationSettings.handler,
  )
  .get(
    "/ai-availability",
    {
      permissions: readAIAvailability.config.permissions,
    },
    readAIAvailability.handler,
  )
  .get(
    "/feature-enrolments",
    {
      permissions: getFeatureEnrolments.config.permissions,
    },
    getFeatureEnrolments.handler,
  )
  .put(
    "/feature-enrolments/:featureId",
    {
      permissions: enrolFeature.config.permissions,
      params: enrolFeature.config.params,
    },
    enrolFeature.handler,
  )
  .delete(
    "/feature-enrolments/:featureId",
    {
      permissions: unenrolFeature.config.permissions,
      params: unenrolFeature.config.params,
    },
    unenrolFeature.handler,
  )
  .get(
    "/feature-access",
    {
      permissions: getFeatureAccess.config.permissions,
    },
    getFeatureAccess.handler,
  )
  .get(
    "/document-ocr-availability",
    {
      permissions: getDocumentOcrAvailability.config.permissions,
    },
    getDocumentOcrAvailability.handler,
  )
  .post(
    "/ai-config/defaults-preview",
    {
      body: previewAIConfigDefaults.config.body,
      permissions: previewAIConfigDefaults.config.permissions,
    },
    previewAIConfigDefaults.handler,
  )
  .get(
    "/ai-config",
    {
      permissions: readAIConfig.config.permissions,
    },
    readAIConfig.handler,
  )
  .post(
    "/ai-config",
    {
      body: updateAIConfig.config.body,
      permissions: updateAIConfig.config.permissions,
    },
    updateAIConfig.handler,
  )
  .delete(
    "/ai-config",
    {
      permissions: deleteAIConfig.config.permissions,
    },
    deleteAIConfig.handler,
  )
  .get(
    "/deepl",
    {
      permissions: readDeepLAvailability.config.permissions,
    },
    readDeepLAvailability.handler,
  )
  .get(
    "/deepl-config",
    {
      permissions: readDeepLConfig.config.permissions,
    },
    readDeepLConfig.handler,
  )
  .post(
    "/deepl",
    {
      body: updateDeepLKey.config.body,
      permissions: updateDeepLKey.config.permissions,
    },
    updateDeepLKey.handler,
  )
  .delete(
    "/deepl",
    {
      permissions: deleteDeepLKey.config.permissions,
    },
    deleteDeepLKey.handler,
  )
  .get(
    "/web-search-config",
    {
      permissions: readWebSearchConfig.config.permissions,
    },
    readWebSearchConfig.handler,
  )
  .post(
    "/web-search-key",
    {
      body: updateWebSearchKey.config.body,
      permissions: updateWebSearchKey.config.permissions,
    },
    updateWebSearchKey.handler,
  )
  .delete(
    "/web-search-key",
    {
      body: deleteWebSearchKey.config.body,
      permissions: deleteWebSearchKey.config.permissions,
    },
    deleteWebSearchKey.handler,
  )
  .get(
    "/anonymization-blacklist",
    {
      permissions: readAnonymizationBlacklist.config.permissions,
    },
    readAnonymizationBlacklist.handler,
  )
  .put(
    "/anonymization-blacklist",
    {
      body: updateAnonymizationBlacklist.config.body,
      permissions: updateAnonymizationBlacklist.config.permissions,
    },
    updateAnonymizationBlacklist.handler,
  );
