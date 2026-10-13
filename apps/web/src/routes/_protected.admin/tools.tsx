import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { NativeToolsList } from "@/routes/_protected.admin/-components/native-tools-list";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/admin/tools")({
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      mcpConnectorsOptions(context.user.activeOrganizationId),
    );
  },
  component: OrganizationToolsPage,
});

function OrganizationToolsPage() {
  const t = useTranslations();
  return (
    <>
      <SettingsPageHeader
        title={t("knowledge.sections.tools.title")}
        description={t("admin.toolsDescription")}
      />
      <NativeToolsList />
    </>
  );
}
