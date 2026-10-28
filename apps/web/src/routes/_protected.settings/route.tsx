import { createFileRoute, Outlet } from "@tanstack/react-router";

import { SettingsShell } from "@/components/settings-shell/settings-shell";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/lib/route-presentation";

export const Route = createFileRoute("/_protected/settings")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.settings",
      to: "/settings",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("common.settings") }],
  }),
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <SettingsShell>
      <Outlet />
    </SettingsShell>
  );
}
