import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";
import { SkillDetailPending } from "@/routes/knowledge/-components/skill-detail.pending";

/** The column a skill's editor fills. */
export const ToolSkillShell = ({ children }: { children?: ReactNode }) => (
  <div className="flex min-h-0 flex-1 flex-col">{children}</div>
);

/** A skill's page before the session and the skill are read: the editor's
 *  own lines. */
export const ToolSkillPending = framePendingView(() => (
  <ToolSkillShell>
    <SkillDetailPending />
  </ToolSkillShell>
));
