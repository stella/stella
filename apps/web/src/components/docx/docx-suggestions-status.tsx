import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { DocxSuggestionsQueryStatus } from "./docx-suggestions-query-status";
import { useSyncDocxSuggestions } from "./use-sync-docx-suggestions";

// Hydration needs the mounted editor's snapshot; its read notice shares that lifetime.
export const DocxSuggestionsStatus = ({
  document: { workspaceId, entityId },
  editorRef,
}: {
  document: { workspaceId: string; entityId: string };
  editorRef: RefObject<DocxEditorRef | null>;
}) => {
  const view = useSyncDocxSuggestions({ workspaceId, entityId, editorRef });
  return <DocxSuggestionsQueryStatus view={view} />;
};
