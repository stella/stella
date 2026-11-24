/**
 * The citation check as the document editor wires it.
 *
 * Off unless the organization's settings admit the `citation-check` feature
 * (the deployment flag and the organization grant both decide that on the
 * server). Off, the editor gets back the selection callback it passed in and
 * nothing else: no timer is armed and no check is ever requested. On, the
 * working half (`citation-check-host`) is loaded lazily, so the editor's own
 * bundle carries only this bridge.
 */

import { lazy, Suspense, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import type { DocxEditorRef } from "@/components/docx/app-docx-editor";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";

const CitationCheckHost = lazy(async () => {
  const module =
    await import("@/components/docx/citation-check/citation-check-host");
  return { default: module.CitationCheckHost };
});

export type TextSelection = { from: number; to: number; text: string };

/** The `DocxEditor` props that carry the "Check citation" menu entry. */
export type CitationCheckMenu = {
  customContextMenuItems: readonly {
    id: string;
    label: string;
    requiresSelection?: boolean;
    icon?: ReactNode;
  }[];
  onCustomContextAction: (
    id: string,
    range: { from: number; to: number },
  ) => void;
};

type UseDocxCitationCheckOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  /** The selection callback the editor already has; always still called. */
  onSelectionTextChange: (selection: TextSelection) => void;
};

type DocxCitationCheck = {
  /** `DocxEditor` props: the selection bridge and, when on, the menu entry. */
  editorProps: {
    onSelectionTextChange: (selection: TextSelection) => void;
  } & Partial<CitationCheckMenu>;
  /** The check's host and answers card; null while the feature is off. */
  card: ReactNode;
};

export const useDocxCitationCheck = ({
  editorRef,
  onSelectionTextChange,
}: UseDocxCitationCheckOptions): DocxCitationCheck => {
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.citationCheck);
  const [menu, setMenu] = useState<CitationCheckMenu | null>(null);
  // Set by the host once it has loaded; a selection before that is simply
  // not checked.
  const selectionRef = useRef<((selection: TextSelection) => void) | null>(
    null,
  );

  if (!enabled) {
    return { editorProps: { onSelectionTextChange }, card: null };
  }

  return {
    editorProps: {
      onSelectionTextChange: (selection) => {
        selectionRef.current?.(selection);
        onSelectionTextChange(selection);
      },
      ...menu,
    },
    card: (
      <Suspense fallback={null}>
        <CitationCheckHost
          editorRef={editorRef}
          onMenuChange={setMenu}
          selectionRef={selectionRef}
        />
      </Suspense>
    ),
  };
};
