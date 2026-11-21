import { ToolContributeContent } from "@/features/knowledge/public/tools/tool-contribute-page";
import { ToolContributeShell } from "@/routes/tools/-contribute.pending";

export const ToolContributePage = () => (
  <ToolContributeShell>
    <ToolContributeContent />
  </ToolContributeShell>
);
