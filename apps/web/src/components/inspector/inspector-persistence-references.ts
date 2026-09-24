import { CASE_DECISION_DETAILS_VIEW } from "@/components/inspector/case-decision-details-view";
import {
  CASE_DECISION_VIEW,
  isCaseDecisionViewPayload,
} from "@/components/inspector/case-decision-view";
import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { registerInspectorPersistenceReference } from "@/components/inspector/view-registry";
import {
  INBOX_SIGNAL_VIEW,
  isInboxSignalViewPayload,
} from "@/features/inbox/signal-inspector.logic";
import {
  isProvisionViewPayload,
  PROVISION_VIEW,
} from "@/features/statutes/provision-inspector.logic";
import {
  isStatuteViewPayload,
  STATUTE_VIEW,
} from "@/features/statutes/statute-inspector.logic";

registerInspectorPersistenceReference({
  type: INBOX_SIGNAL_VIEW,
  validate: isInboxSignalViewPayload,
  project: ({ signalId }) => ({ signalId }),
});

/**
 * What survives a reload of a decision tab: its route identity and the
 * passage it was opened at. The words that found it do not — a reopened
 * reader marks nothing until it is searched again.
 */
const projectCaseDecision = ({
  anchorId,
  caseNumber,
  country,
  court,
  decisionId,
  route,
}: CaseDecisionViewPayload): CaseDecisionViewPayload => ({
  caseNumber,
  country,
  court,
  decisionId,
  route,
  ...(anchorId === undefined ? {} : { anchorId }),
});

registerInspectorPersistenceReference({
  type: CASE_DECISION_VIEW,
  validate: isCaseDecisionViewPayload,
  project: projectCaseDecision,
});

// The facts of a decision are the same payload under a second view kind, so
// the tab that holds them comes back from a reload the way the text tab does.
registerInspectorPersistenceReference({
  type: CASE_DECISION_DETAILS_VIEW,
  validate: isCaseDecisionViewPayload,
  project: projectCaseDecision,
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

// An act tab carries only its address and its name: the wording itself is
// read again, so a reload comes back on the consolidation the citation
// resolved to rather than on whatever is latest.
registerInspectorPersistenceReference({
  type: STATUTE_VIEW,
  validate: isStatuteViewPayload,
  project: ({
    country,
    documentId,
    eli,
    slug,
    statuteTitle,
    versionValidFrom,
  }) => ({
    country,
    documentId,
    eli,
    slug,
    statuteTitle,
    versionValidFrom,
  }),
});
