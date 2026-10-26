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
import { routes } from "@/api/http/route";

import {
  listBillingKnowledgeFiles,
  readBillingKnowledgeFile,
} from "./billing-drafts";
import readBillingDraftConfiguration from "./billing-drafts/get";
import updateBillingDraftConfiguration from "./billing-drafts/update";

export const organizationSettingsRoute = routes(
  {
    "/billing-drafts": {
      GET: readBillingDraftConfiguration,
      POST: updateBillingDraftConfiguration,
    },
    "/billing-drafts/knowledge-files": { GET: listBillingKnowledgeFiles },
    "/billing-drafts/knowledge-files/:resourceId": {
      GET: readBillingKnowledgeFile,
    },
    "/correspondence/allowed-senders": {
      GET: listCorrespondenceAllowedSenders,
      POST: createCorrespondenceAllowedSender,
    },
    "/correspondence/allowed-senders/:senderId": {
      DELETE: deleteCorrespondenceAllowedSender,
    },
    "/correspondence/allowed-senders/:senderId/scope": {
      POST: addCorrespondenceAllowedSenderScope,
      DELETE: removeCorrespondenceAllowedSenderScope,
    },
    "/": { GET: readOrganizationSettings, POST: updateOrganizationSettings },
    "/business-registry-credentials": {
      GET: readBusinessRegistryCredentials,
      POST: saveBusinessRegistryCredential,
      DELETE: deleteBusinessRegistryCredential,
    },
    "/sanctions-monitoring": { POST: updateSanctionsMonitoring },
    "/practice-jurisdictions": { POST: updatePracticeJurisdictions },
    "/preview": { POST: previewOrganizationSettings },
    "/ai-availability": { GET: readAIAvailability },
    "/feature-enrolments": { GET: getFeatureEnrolments },
    "/feature-enrolments/:featureId": {
      PUT: enrolFeature,
      DELETE: unenrolFeature,
    },
    "/feature-access": { GET: getFeatureAccess },
    "/document-ocr-availability": { GET: getDocumentOcrAvailability },
    "/ai-config/defaults-preview": { POST: previewAIConfigDefaults },
    "/ai-config": {
      GET: readAIConfig,
      POST: updateAIConfig,
      DELETE: deleteAIConfig,
    },
    "/deepl": {
      GET: readDeepLAvailability,
      POST: updateDeepLKey,
      DELETE: deleteDeepLKey,
    },
    "/deepl-config": { GET: readDeepLConfig },
    "/web-search-config": { GET: readWebSearchConfig },
    "/web-search-key": { POST: updateWebSearchKey, DELETE: deleteWebSearchKey },
    "/anonymization-blacklist": {
      GET: readAnonymizationBlacklist,
      PUT: updateAnonymizationBlacklist,
    },
  },
  { prefix: "/organization-settings" },
);
