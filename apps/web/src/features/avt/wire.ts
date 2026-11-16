/**
 * The list verification API's wire shapes, read off the printed route types
 * alone. Nothing else is imported here, so the browser specs' project can
 * compile the AVT fixtures that are built from these types and share them with
 * the unit tests instead of keeping an untyped copy of the contract.
 */

import type { WebRoutes } from "@/generated/api-routes.gen";

export type ListsRoutes = WebRoutes["v1"]["lists"][":workspaceId"];

export type VerificationRun =
  ListsRoutes["verifications"][":runId"]["get"]["response"][200];
export type VerificationClaim = VerificationRun["claims"][number];
export type ClaimReview = NonNullable<VerificationClaim["review"]>;
export type ClaimVerdict = VerificationClaim["verdict"];
export type EvidenceFact = VerificationRun["evidence"]["facts"][number];
