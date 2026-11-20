import { ToolContributeFormPending } from "@/features/knowledge/public/tools/tool-contribute-shell.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

export { ToolContributeShell } from "@/features/knowledge/public/tools/tool-contribute-shell.pending";

export const ToolContributePending = framePendingView(
  ToolContributeFormPending,
);
