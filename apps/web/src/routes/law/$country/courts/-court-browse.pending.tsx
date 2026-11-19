import {
  PublicLawHubLayout,
  PublicLawHubPending,
} from "@/routes/law/-components/public-law-hub.pending";

// A court hub's shell and its loading view: the route renders
// CourtBrowsePending while the page chunk and the court's calendar or listing
// load, and the page renders the same shell.

export const CourtBrowseShell = PublicLawHubLayout;

export const CourtBrowsePending = PublicLawHubPending;
