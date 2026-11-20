import { useState } from "react";

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { useLatestCallback } from "@/hooks/use-latest-callback";

import { createEvidenceReferencesPlugin } from "./evidence-reference";

export const useEvidenceReferences = (editable: boolean) => {
  const [document, setDocument] = useState<ProseMirrorNode | null>(null);
  const isEditable = useLatestCallback(() => editable);
  // Folio retains these plugins across document replacement; identity must stay stable.
  const plugins = [
    createEvidenceReferencesPlugin({
      isEditable,
      onDocumentChange: setDocument,
    }),
  ];
  return { document, plugins };
};
