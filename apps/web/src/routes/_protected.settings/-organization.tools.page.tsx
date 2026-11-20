import { NativeToolsList } from "@/routes/_protected.settings/organization/-components/native-tools-list";
import { SharepointCard } from "@/routes/_protected.settings/organization/-components/organization/sharepoint-card";

import { ToolsShell } from "./-organization.tools.pending";

export function OrganizationToolsPage() {
  return (
    <ToolsShell>
      <NativeToolsList />
      <SharepointCard />
    </ToolsShell>
  );
}
