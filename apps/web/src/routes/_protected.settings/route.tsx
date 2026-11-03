import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";

import { SettingsShell } from "@/components/settings-shell/settings-shell";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

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
  // A stale settings link stays in settings rather than leaving for the
  // matters list.
  notFoundComponent: () => <Navigate replace to="/settings/account/profile" />,
});

function SettingsLayout() {
  return (
    <SettingsShell>
      <Outlet />
    </SettingsShell>
  );
}
