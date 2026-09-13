import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Research tables are retired: a question column belongs to the organization
 * and is asked on the results table itself, so a saved list of decisions has
 * nothing left to hold. Old links land on the results, where the questions and
 * their answers now live.
 */
export const Route = createFileRoute("/law/cases/research/")({
  beforeLoad: () => {
    throw redirect({ to: "/law/cases", replace: true });
  },
});
