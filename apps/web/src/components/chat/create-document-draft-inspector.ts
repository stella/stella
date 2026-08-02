import {
  CreateDocumentDraftInspector,
  CreateDocumentDraftRailIcon,
} from "@/components/chat/create-document-draft-inspector-view";
import {
  CREATE_DOCUMENT_DRAFT_VIEW,
  type CreateDocumentDraftPayload,
  isCreateDocumentDraftPayload,
} from "@/components/chat/create-document-draft.logic";
import { registerInspectorView } from "@/components/inspector/view-registry";

registerInspectorView<CreateDocumentDraftPayload>({
  type: CREATE_DOCUMENT_DRAFT_VIEW,
  render: CreateDocumentDraftInspector,
  railIcon: CreateDocumentDraftRailIcon,
  navigationPolicy: "persist",
  validate: isCreateDocumentDraftPayload,
  ariaLabel: (tab) => tab.label,
  maxMounted: 1,
});
