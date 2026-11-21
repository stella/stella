import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { LeafPendingView } from "@/routes/-route-pending-view";
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
  // A layout: its pending view is the page it leads to, which draws the
  // settings chrome itself where this shell is not mounted yet.
  pendingComponent: LeafPendingView,
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
