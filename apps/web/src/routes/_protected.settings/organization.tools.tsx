import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { NativeToolsList } from "@/routes/_protected.settings/organization/-components/native-tools-list";

export const Route = createFileRoute("/_protected/settings/organization/tools")(
  {
    staticData: {
      presentation: routePresentation({
        type: "label",
        labelKey: "knowledge.sections.tools.title",
        to: "/settings/organization/tools",
      }),
    },
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
  },
);

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
