import { createFileRoute, notFound } from "@tanstack/react-router";

import { Skeleton } from "@stll/ui/skeleton";

import "@/features/case-law/case-decision-details-inspector-registration";
import "@/features/case-law/case-decision-inspector-registration";
import "@/features/statutes/provision-inspector-registration";
import "@/features/statutes/statute-inspector-registration";
import { isPublicLawRouteEnabled } from "@/lib/public-law-launch";
import { PublicLawShell } from "@/routes/law/-components/public-law-shell";

export const Route = createFileRoute("/law")({
  beforeLoad: () => {
    if (!isPublicLawRouteEnabled()) {
      throw notFound();
    }
  },
  component: LawRouteComponent,
  // The shell is also this match's suspense fallback. Without one of its own,
  // a suspension no narrower boundary catches would replace the breadcrumbs,
  // the country and language controls and the inspector rail with the
  // router's spinner — none of which is what is loading.
  pendingComponent: LawShellPending,
});

function LawRouteComponent() {
  return <PublicLawShell />;
}

function LawShellPending() {
  return <PublicLawShell content={<PublicLawContentPending />} />;
}

/** The frame every page under `/law` fills, with nothing claimed inside it. */
const PublicLawContentPending = () => (
  <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">
    <Skeleton className="h-9 w-full max-w-md rounded-md" />
    <Skeleton className="min-h-0 flex-1 rounded-md" />
  </main>
);
