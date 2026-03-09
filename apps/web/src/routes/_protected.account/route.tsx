import { createFileRoute, Outlet } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_protected/account")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.account") }],
  }),
  component: AccountLayout,
});

function AccountLayout() {
  return (
    <div className="flex flex-1 flex-col gap-4 border-t p-4">
      <Outlet />
    </div>
  );
}
