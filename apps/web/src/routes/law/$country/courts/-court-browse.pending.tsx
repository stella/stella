import { framePendingView } from "@/routes/-pending-view.logic";
import {
  PublicLawHubLayout,
  PublicLawHubPending,
} from "@/routes/law/-components/public-law-hub.pending";

// A court hub's shell and its loading view: the route renders
// CourtBrowsePending while the page chunk and the court's calendar or listing
// load, and the page renders the same shell. The view is context-free, so the
// cold-load frame draws it before the providers mount.

export const CourtBrowseShell = PublicLawHubLayout;

export const CourtBrowsePending = framePendingView(PublicLawHubPending);
