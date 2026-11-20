import { createFileRoute } from "@tanstack/react-router";

import { publicDecisionSearchSchema } from "@/routes/law/-case-detail.logic";
import { PublicDecisionPage } from "@/routes/law/-case-detail.page";
import { DecisionReaderPending } from "@/routes/law/-case-detail.pending";
import {
  loadPublicDecisionRoute,
  publicDecisionHead,
} from "@/routes/law/-public-decision-route";

export const Route = createFileRoute("/law/$country/cases/$court/$slug")({
  validateSearch: publicDecisionSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: loadPublicDecisionRoute,
  head: publicDecisionHead,
  component: PublicDecisionPage,
  pendingComponent: DecisionReaderPending,
});
