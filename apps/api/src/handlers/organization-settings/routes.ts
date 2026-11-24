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
import addDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/add";
import checkDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/check";
import deleteDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/delete";
import exportDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/export";
import listDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/list";
import getDocumentOcrAvailability from "@/api/handlers/organization-settings/document-ocr-availability/get";
import getFeatureAccess from "@/api/handlers/organization-settings/feature-access/get";
import enrolFeature from "@/api/handlers/organization-settings/feature-enrolments/enrol";
import getFeatureEnrolments from "@/api/handlers/organization-settings/feature-enrolments/get";
import unenrolFeature from "@/api/handlers/organization-settings/feature-enrolments/unenrol";
import readOrganizationSettings from "@/api/handlers/organization-settings/get";
import updateLocalRunApprovalCeiling from "@/api/handlers/organization-settings/local-runs/update";
import updateMemberBillingAccess from "@/api/handlers/organization-settings/members/billing-access/update";
import updatePracticeJurisdictions from "@/api/handlers/organization-settings/practice-jurisdictions/update";
import previewOrganizationSettings from "@/api/handlers/organization-settings/preview";
import readAIConfig from "@/api/handlers/organization-settings/read-ai-config";
import readDeepLConfig from "@/api/handlers/organization-settings/read-deepl-config";
import readWebSearchConfig from "@/api/handlers/organization-settings/read-web-search-config";
import updateSanctionsMonitoring from "@/api/handlers/organization-settings/sanctions-monitoring/update";
import approveOrganizationSsoPendingMember from "@/api/handlers/organization-settings/sso/approve-pending-member";
import createOrganizationSsoDomain from "@/api/handlers/organization-settings/sso/create-domain";
import createOrganizationSsoProvider from "@/api/handlers/organization-settings/sso/create-provider";
import createOrganizationSamlSsoProvider from "@/api/handlers/organization-settings/sso/create-saml-provider";
import createOrganizationScimToken from "@/api/handlers/organization-settings/sso/create-scim-token";
import deleteOrganizationSsoDomain from "@/api/handlers/organization-settings/sso/delete-domain";
import deleteOrganizationSsoProvider from "@/api/handlers/organization-settings/sso/delete-provider";
import readOrganizationSso from "@/api/handlers/organization-settings/sso/get";
import parseOrganizationSamlMetadata from "@/api/handlers/organization-settings/sso/parse-saml-metadata";
import rejectOrganizationSsoPendingMember from "@/api/handlers/organization-settings/sso/reject-pending-member";
import revokeOrganizationScimToken from "@/api/handlers/organization-settings/sso/revoke-scim-token";
import testOrganizationSsoProvider from "@/api/handlers/organization-settings/sso/test-provider";
import updateOrganizationSsoPolicy from "@/api/handlers/organization-settings/sso/update-policy";
import verifyOrganizationSsoDomain from "@/api/handlers/organization-settings/sso/verify-domain";
import updateOrganizationSettings from "@/api/handlers/organization-settings/update";
import updateAIConfig from "@/api/handlers/organization-settings/update-ai-config";
import updateDeepLKey from "@/api/handlers/organization-settings/update-deepl-key";
import updateWebSearchKey from "@/api/handlers/organization-settings/update-web-search-key";
import updateVerificationDecisionModel from "@/api/handlers/organization-settings/verification-decision-model/update";
import { mount, routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

import {
  listBillingKnowledgeFiles,
  readBillingKnowledgeFile,
} from "./billing-drafts";
import readBillingDraftConfiguration from "./billing-drafts/get";
import updateBillingDraftConfiguration from "./billing-drafts/update";

export const organizationSettingsRoute = mount(
  [
    routes(
      {
        "/": {
          GET: readBillingDraftConfiguration,
          POST: updateBillingDraftConfiguration,
        },
        "/knowledge-files": { GET: listBillingKnowledgeFiles },
        "/knowledge-files/:resourceId": {
          GET: readBillingKnowledgeFile,
        },
      },
      {
        prefix: "/billing-drafts",
        middleware: [
          deploymentFeatureGate("FEATURE_TIME_BILLING"),
          featureAccessGate("time-billing"),
        ],
      },
    ),
    routes(
      { "/": { POST: updateVerificationDecisionModel } },
      {
        prefix: "/verification-decision-model",
        middleware: [deploymentFeatureGate("FEATURE_LEGAL_LISTS")],
      },
    ),
    routes(
      {
        "/": { GET: readOrganizationSso },
        "/policy": { PUT: updateOrganizationSsoPolicy },
        "/providers": { POST: createOrganizationSsoProvider },
        "/providers/saml": { POST: createOrganizationSamlSsoProvider },
        "/providers/test": { POST: testOrganizationSsoProvider },
        "/saml/parse-metadata": { POST: parseOrganizationSamlMetadata },
        "/providers/:providerId": { DELETE: deleteOrganizationSsoProvider },
        "/domains": { POST: createOrganizationSsoDomain },
        "/domains/:domainId/verify": { POST: verifyOrganizationSsoDomain },
        "/domains/:domainId": { DELETE: deleteOrganizationSsoDomain },
        "/pending-members/:pendingId/approve": {
          POST: approveOrganizationSsoPendingMember,
        },
        "/pending-members/:pendingId/reject": {
          POST: rejectOrganizationSsoPendingMember,
        },
        "/scim-tokens": { POST: createOrganizationScimToken },
        "/scim-tokens/:tokenId": { DELETE: revokeOrganizationScimToken },
      },
      {
        prefix: "/sso",
        middleware: [deploymentFeatureGate("FEATURE_ENTERPRISE_SSO")],
      },
    ),
    routes({
      "/correspondence/data-boxes": {
        GET: getOrganizationDataBoxes,
        POST: addOrganizationDataBox,
      },
      "/correspondence/data-boxes/:boxId": {
        DELETE: removeOrganizationDataBox,
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
      "/local-runs": { POST: updateLocalRunApprovalCeiling },
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
      "/web-search-key": {
        POST: updateWebSearchKey,
        DELETE: deleteWebSearchKey,
      },
      "/anonymization-blacklist": {
        GET: readAnonymizationBlacklist,
        PUT: updateAnonymizationBlacklist,
      },
      "/dictation-vocabulary": {
        GET: listDictationVocabulary,
        POST: addDictationVocabulary,
        DELETE: deleteDictationVocabulary,
      },
      "/dictation-vocabulary/check": { POST: checkDictationVocabulary },
      "/dictation-vocabulary/export": { GET: exportDictationVocabulary },
    }),
    routes(
      {
        "/members/:memberId/billing": { PUT: updateMemberBillingAccess },
      },
      {
        middleware: [
          deploymentFeatureGate("FEATURE_TIME_BILLING"),
          featureAccessGate("time-billing"),
        ],
      },
    ),
  ],
  { prefix: "/organization-settings" },
);
