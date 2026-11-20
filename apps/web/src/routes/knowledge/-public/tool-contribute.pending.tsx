import type { ReactNode } from "react";

import { ContributePagePending } from "@/features/knowledge/public/tools/tool-contribute-page.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The column the contribute page fills. */
export const ToolContributeShell = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-0 flex-1 flex-col">{children}</div>
);

/** How to add a tool to the catalogue, while its page loads. */
export const ToolContributePending = framePendingView(() => (
  <ToolContributeShell>
    <ContributePagePending />
  </ToolContributeShell>
));
