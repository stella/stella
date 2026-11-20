import type { ReactNode } from "react";

import { DocxLoadingShell } from "@/components/docx/docx-loading-shell";
import { framePendingView } from "@/routes/-pending-view.logic";

export function VerifyShell({ children }: { children?: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1">
      <DocxLoadingShell />
      {children}
    </div>
  );
}

export const VerifyPending = framePendingView(() => <VerifyShell />);
