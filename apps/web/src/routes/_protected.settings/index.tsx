import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/account/profile", replace: true });
  },
});
