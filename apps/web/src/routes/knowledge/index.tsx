import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";
import { KnowledgeLandingPage } from "@/routes/knowledge/-knowledge-landing.page";
import { KnowledgeLandingPending } from "@/routes/knowledge/-knowledge-landing.pending";

const searchSchema = routeSearchSchema({
  /** An organization-only Knowledge page a visitor asked for. */
  from: v.fallback(v.optional(v.string()), undefined),
});

export const Route = createFileRoute("/knowledge/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  validateSearch: searchSchema,
  component: KnowledgeLandingPage,
  pendingComponent: KnowledgeLandingPending,
});
