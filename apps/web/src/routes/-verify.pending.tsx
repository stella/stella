import type { ReactNode } from "react";

import { DocxLoadingSheetPending } from "@/components/docx/docx-loading-sheet.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

export function VerifyShell({ children }: { children?: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1">
      <DocxLoadingSheetPending />
      {children}
    </div>
  );
}

export const VerifyPending = framePendingView(() => <VerifyShell />);
