import { createFileRoute, Outlet } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsShell } from "@/routes/_protected.settings/-components/settings-shell/settings-shell";

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
