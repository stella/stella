import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/law/")({
  beforeLoad: () => {
    throw redirect({ to: "/law/cases", replace: true });
  },
});
