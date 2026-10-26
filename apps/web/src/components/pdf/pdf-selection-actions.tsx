import { useRef } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";

import { PdfSelectionToolbar } from "@/components/pdf/pdf-selection-toolbar";
import type { PdfSelectionChat } from "@/components/pdf/pdf-selection-toolbar";
import { useMatterNumberingEnabled } from "@/lib/organization/use-matter-numbering";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { useQueryView } from "@/lib/use-query-view";
import { workspaceOptions } from "@/lib/workspaces/queries";

type PdfSelectionActionsProps = {
  chat: PdfSelectionChat;
  children: ReactNode;
  fileFieldId: string;
  fileName: string;
  workspaceId: string;
};

/**
 * Wraps a matter PDF viewer so selected words get the selection bar. The
 * citation names the matter's reference only where the organization shows
 * matter numbers, and numbers pages as the viewer's page indicator does.
 */
export const PdfSelectionActions = ({
  chat,
  children,
  fileFieldId,
  fileName,
  workspaceId,
}: PdfSelectionActionsProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const showMatterNumber = useMatterNumberingEnabled();
  const workspaceView = useQueryView(useQuery(workspaceOptions(workspaceId)));
  const reference =
    showMatterNumber && workspaceView.type === "items"
      ? workspaceView.items.reference
      : null;
  const pages = usePDFStore((state) => state.pages);
  const pageIds = pages.keys().toArray();
  const pageNumberOf = (pageId: string): number | null => {
    const index = pageIds.indexOf(pageId);
    return index === -1 ? null : index + 1;
  };

  return (
    <div className="h-full" ref={rootRef}>
      {children}
      <PdfSelectionToolbar
        chat={chat}
        citedDocument={{ fileFieldId, name: fileName, reference }}
        pageNumberOf={pageNumberOf}
        rootRef={rootRef}
      />
    </div>
  );
};
