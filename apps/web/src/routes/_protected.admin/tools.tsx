import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { NativeToolsList } from "@/routes/_protected.admin/-components/native-tools-list";

export const Route = createFileRoute("/_protected/admin/tools")({
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      mcpConnectorsOptions(context.user.activeOrganizationId),
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("knowledge.sections.tools.title") }],
  }),
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
