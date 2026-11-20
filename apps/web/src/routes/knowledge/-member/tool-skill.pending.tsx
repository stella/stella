import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";

/** The column a skill's editor fills; it draws its own loading state. */
export const ToolSkillShell = ({ children }: { children?: ReactNode }) => (
  <div className="flex min-h-0 flex-1 flex-col">{children}</div>
);

/** A skill's page before its editor loads. */
export const ToolSkillPending = framePendingView(() => <ToolSkillShell />);
