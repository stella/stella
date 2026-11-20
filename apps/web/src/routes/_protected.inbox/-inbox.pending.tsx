import type { ReactNode } from "react";

import { EntityViewsPending } from "@/components/entity-views/entity-views.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The inbox page's region: the views fill it, in both phases. */
export const InboxShell = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-0 flex-1 flex-col">{children}</div>
);

/**
 * The inbox before its saved views have loaded: the views' chrome and the
 * active view's body as the cache or this browser last left them.
 */
const InboxPendingView = () => (
  <InboxShell>
    <EntityViewsPending />
  </InboxShell>
);

export const InboxPending = framePendingView(InboxPendingView);
