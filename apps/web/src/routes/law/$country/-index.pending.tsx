import { framePendingView } from "@/routes/-pending-view.logic";
import {
  PublicLawHubLayout,
  PublicLawHubPending,
} from "@/routes/law/-components/public-law-hub.pending";

// A jurisdiction hub's shell and its loading view: the route renders
// JurisdictionHubPending while the page chunk and the court list load, and
// the page renders the same shell. The view is context-free, so the cold-load
// frame draws it before the providers mount.

export const JurisdictionHubShell = PublicLawHubLayout;

const JurisdictionHubPendingView = () => <PublicLawHubPending />;

export const JurisdictionHubPending = framePendingView(
  JurisdictionHubPendingView,
);
