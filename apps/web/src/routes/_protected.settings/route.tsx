import { createFileRoute, Outlet } from "@tanstack/react-router";

import { SettingsShell } from "@/components/settings-shell/settings-shell";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_protected/settings")({
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
