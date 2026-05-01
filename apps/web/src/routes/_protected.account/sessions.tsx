import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/account/sessions")({
  beforeLoad: () => {
    throw redirect({ to: "/account/settings", replace: true });
  },
});
