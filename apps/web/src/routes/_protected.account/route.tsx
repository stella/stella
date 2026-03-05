import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/account")({
  component: AccountLayout,
});

function AccountLayout() {
  return (
    <div className="flex flex-1 flex-col gap-4 border-t p-4">
      <Outlet />
    </div>
  );
}
