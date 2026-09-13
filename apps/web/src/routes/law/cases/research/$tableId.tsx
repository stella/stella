import { createFileRoute, redirect } from "@tanstack/react-router";

/** One retired research table; its questions are on the results table now. */
export const Route = createFileRoute("/law/cases/research/$tableId")({
  beforeLoad: () => {
    throw redirect({ to: "/law/cases", replace: true });
  },
});
