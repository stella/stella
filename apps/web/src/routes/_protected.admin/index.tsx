import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";

import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  const t = useTranslations();
  return (
    <>
      <SettingsPageHeader
        title={t("workspaces.views.layouts.overview")}
        description={t("admin.overviewDescription")}
      />
      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-3">
            <Link to="/admin/general" className="text-sm underline">
              {t("admin.general")}
            </Link>
            <Link to="/admin/members" className="text-sm underline">
              {t("common.members")}
            </Link>
            <Link to="/admin/ai" className="text-sm underline">
              {t("admin.modelsAndProviders")}
            </Link>
            <Link to="/admin/tools" className="text-sm underline">
              {t("knowledge.sections.tools.title")}
            </Link>
            <Link to="/admin/usage" className="text-sm underline">
              {t("admin.planAndUsage")}
            </Link>
            <Link to="/admin/audit-logs" className="text-sm underline">
              {t("settings.organization.auditLogs")}
            </Link>
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}
