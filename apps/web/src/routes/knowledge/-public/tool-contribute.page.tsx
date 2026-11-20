import { ToolContributeContent } from "@/features/knowledge/public/tools/tool-contribute-page";
import { ToolContributeShell } from "@/routes/knowledge/-public/tool-contribute.pending";

/** How to add a tool to the published catalogue. */
export const ToolContributePage = () => (
  <ToolContributeShell>
    <ToolContributeContent />
  </ToolContributeShell>
);
