import { useState } from "react";

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import {
  createEvidenceReferencesPlugin,
  EVIDENCE_DERIVED_FIELDS,
} from "./evidence-reference";

export const useEvidenceReferences = () => {
  const [document, setDocument] = useState<ProseMirrorNode | null>(null);
  // Folio retains these plugins across document replacement; identity must stay stable.
  const plugins = [createEvidenceReferencesPlugin(setDocument)];
  return { derivedFields: EVIDENCE_DERIVED_FIELDS, document, plugins };
};
