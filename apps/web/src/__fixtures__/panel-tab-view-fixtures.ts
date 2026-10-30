import "@/components/chat/create-document-draft-inspector";
import "@/features/case-law/case-decision-details-inspector-registration";
import "@/features/case-law/case-decision-inspector-registration";
import "@/features/inbox/signal-inspector-registration";
import "@/features/knowledge/playbook-editor/playbook-draft-view-registration";
import "@/features/statutes/provision-inspector-registration";
import "@/features/statutes/statute-inspector-registration";

import {
  buildCreateDocumentDraftPayload,
  CREATE_DOCUMENT_DRAFT_VIEW,
} from "@/components/chat/create-document-draft.logic";
import { CASE_DECISION_DETAILS_VIEW } from "@/components/inspector/case-decision-details-view";
import {
  CASE_DECISION_VIEW,
  type CaseDecisionViewPayload,
} from "@/components/inspector/case-decision-view";
import type { GenericTab } from "@/components/inspector/inspector-store-types";
import {
  INBOX_SIGNAL_VIEW,
  type InboxSignalViewPayload,
} from "@/features/inbox/signal-inspector.logic";
import {
  PROVISION_VIEW,
  type ProvisionViewPayload,
} from "@/features/statutes/provision-inspector-contract";
import {
  STATUTE_VIEW,
  type StatuteViewPayload,
} from "@/features/statutes/statute-inspector.logic";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import {
  PLAYBOOK_DRAFT_VIEW,
  type PlaybookDraftViewPayload,
} from "@/lib/knowledge/playbook-draft-view";

const FIXTURE_ID = "00000000-0000-4000-8000-000000000001";
const caseDecisionPayload = {
  caseNumber: "21 Cdo 123/2024",
  country: "cz",
  court: "Nejvyšší soud",
  decisionId: FIXTURE_ID,
  route: { country: "cz", court: "ns", slug: "21-cdo-123-2024" },
} as const satisfies CaseDecisionViewPayload;

export const warmPanelViewRenderers = async () => {
  await Promise.all([
    import("@/features/case-law/components/case-decision-inspector-view"),
    import("@/features/case-law/components/case-decision-details-inspector-view"),
    import("@/features/statutes/components/statute-inspector-view"),
    import("@/features/statutes/components/provision-inspector-view"),
    import("@/features/inbox/components/signal-inspector-view"),
    import("@/features/knowledge/playbook-editor/playbook-draft-view"),
  ]);
};

export const genericPanelFixtures = [
  {
    type: "view",
    viewType: CASE_DECISION_VIEW,
    id: `decision:${FIXTURE_ID}`,
    label: "21 Cdo 123/2024",
    payload: caseDecisionPayload,
  },
  {
    type: "view",
    viewType: CASE_DECISION_DETAILS_VIEW,
    id: `decision-details:${FIXTURE_ID}`,
    label: "21 Cdo 123/2024",
    payload: caseDecisionPayload,
  },
  {
    type: "view",
    viewType: STATUTE_VIEW,
    id: `statute:${FIXTURE_ID}`,
    label: "Občanský zákoník",
    payload: {
      country: "cz",
      documentId: FIXTURE_ID,
      eli: "eli/cz/sb/2012/89",
      slug: "89-2012",
      statuteTitle: "Občanský zákoník",
      versionValidFrom: "2024-01-01",
    } satisfies StatuteViewPayload,
  },
  {
    type: "view",
    viewType: PROVISION_VIEW,
    id: `provision:${FIXTURE_ID}`,
    label: "§ 47",
    payload: {
      documentId: FIXTURE_ID,
      eli: "eli/cz/sb/2012/89",
      jurisdiction: "cz",
      anchorId: "par_47",
      provisionLabel: "§ 47",
      statuteTitle: "Občanský zákoník",
      versionValidFrom: "2024-01-01",
      versionCount: 1,
    } satisfies ProvisionViewPayload,
  },
  {
    type: "view",
    viewType: INBOX_SIGNAL_VIEW,
    id: `signal:${FIXTURE_ID}`,
    label: "Legislative update",
    payload: { signalId: FIXTURE_ID } satisfies InboxSignalViewPayload,
  },
  {
    type: "view",
    viewType: PLAYBOOK_DRAFT_VIEW,
    id: `playbook:${FIXTURE_ID}`,
    label: "Contract review",
    payload: {
      type: "playbook",
      playbookId: FIXTURE_ID,
    } satisfies PlaybookDraftViewPayload,
  },
  {
    type: "view",
    viewType: CREATE_DOCUMENT_DRAFT_VIEW,
    id: `draft:${FIXTURE_ID}`,
    label: "Engagement letter",
    payload: buildCreateDocumentDraftPayload({
      originChatThreadId: toChatThreadId(FIXTURE_ID),
      existingPayload: null,
      draft: {
        messageId: FIXTURE_ID,
        toolCallId: FIXTURE_ID,
        name: "Engagement letter",
        source: "# Engagement letter\n\nScope of legal services.",
        status: "ready",
      },
    }),
  },
] as const satisfies readonly GenericTab[];
