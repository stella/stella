import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_protected/settings/organization/catalogue",
)({
  beforeLoad: () => {
    throw redirect({ to: "/knowledge/tools", replace: true });
  },
});
