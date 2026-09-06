import {
  CASE_DECISION_VIEW,
  isCaseDecisionViewPayload,
} from "@/components/inspector/case-decision-view";
import { registerInspectorPersistenceReference } from "@/components/inspector/view-registry";
import {
  INBOX_SIGNAL_VIEW,
  isInboxSignalViewPayload,
} from "@/features/inbox/signal-inspector.logic";
import {
  isProvisionViewPayload,
  PROVISION_VIEW,
} from "@/features/statutes/provision-inspector.logic";

registerInspectorPersistenceReference({
  type: INBOX_SIGNAL_VIEW,
  validate: isInboxSignalViewPayload,
  project: ({ signalId }) => ({ signalId }),
});

registerInspectorPersistenceReference({
  type: CASE_DECISION_VIEW,
  validate: isCaseDecisionViewPayload,
  project: ({
    anchorId,
    caseNumber,
    country,
    court,
    decisionId,
    language,
    slug,
  }) => ({
    caseNumber,
    country,
    court,
    decisionId,
    slug,
    ...(language === undefined ? {} : { language }),
    ...(anchorId === undefined ? {} : { anchorId }),
  }),
});

registerInspectorPersistenceReference({
  type: PROVISION_VIEW,
  validate: isProvisionViewPayload,
  project: ({
    anchorId,
    documentId,
    eli,
    highlightAnchorId,
    jurisdiction,
    provisionLabel,
    statuteTitle,
    versionCount,
    versionValidFrom,
  }) => ({
    anchorId,
    documentId,
    eli,
    jurisdiction,
    provisionLabel,
    statuteTitle,
    versionCount,
    versionValidFrom,
    ...(highlightAnchorId === undefined ? {} : { highlightAnchorId }),
  }),
});
