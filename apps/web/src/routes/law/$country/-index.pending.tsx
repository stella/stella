import {
  PublicLawHubLayout,
  PublicLawHubPending,
} from "@/routes/law/-components/public-law-hub.pending";

// A jurisdiction hub's shell and its loading view: the route renders
// JurisdictionHubPending while the page chunk and the court list load, and
// the page renders the same shell.

export const JurisdictionHubShell = PublicLawHubLayout;

export const JurisdictionHubPending = PublicLawHubPending;
