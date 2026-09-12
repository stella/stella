import { useMemo, useState } from "react";

import type { Node as ProseMirrorNode } from "prosemirror-model";

import { useLatestCallback } from "@/hooks/use-latest-callback";

import { createEvidenceReferencesPlugin } from "./evidence-reference";

export const useEvidenceReferences = (editable: boolean) => {
  const [document, setDocument] = useState<ProseMirrorNode | null>(null);
  const isEditable = useLatestCallback(() => editable);
  // Folio retains these plugins across document replacement; identity must stay stable.
  const plugins = useMemo(
    () => [
      createEvidenceReferencesPlugin({
        isEditable,
        onDocumentChange: setDocument,
      }),
    ],
    [isEditable],
  );
  return { document, plugins };
};
