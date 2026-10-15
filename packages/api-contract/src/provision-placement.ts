/** Every stored citation reaches a placement or one of these explicit outcomes. */
export const PROVISION_PLACEMENT_FAILURE_REASONS = [
  "work-unresolved",
  "statute-not-loaded",
  "no-version-in-force",
  "version-not-stated",
  "sentence-unlocatable",
  "reference-unlocatable",
  "span-out-of-bounds",
  "span-overlap",
  "ambiguous-placement",
  "page-limit-reached",
] as const;

export type ProvisionPlacementFailureReason =
  (typeof PROVISION_PLACEMENT_FAILURE_REASONS)[number];

export type ProvisionPlacementFailure = {
  id: string;
  reason: ProvisionPlacementFailureReason;
};
