import type { ReactNode } from "react";

import { MarkdownPagePending } from "@/features/knowledge/public/tools/markdown-page.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The column a published tool's page fills. */
export const ToolEntryShell = ({ children }: { children?: ReactNode }) => (
  <div className="flex min-h-0 flex-1 flex-col">{children}</div>
);

/** A published tool's page before its entry has been read: the page's own
 *  frame with its documentation's place held. */
export const ToolEntryPending = framePendingView(() => (
  <ToolEntryShell>
    <MarkdownPagePending />
  </ToolEntryShell>
));
