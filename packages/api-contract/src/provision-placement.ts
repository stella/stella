/** Every stored citation reaches a placement or one of these explicit outcomes. */
export const PROVISION_PLACEMENT_FAILURE_REASONS = [
  "work-unresolved",
  "work-identity-invalid",
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

/**
 * Whether a failure means the linker produced a row the reader cannot place
 * (`defect`), or the cited text is simply not available to this reader
 * (`expected`: unresolved work, statute or version outside the corpus, the
 * page limit). Total over the reasons, so a new reason needs a decision.
 */
export const PROVISION_PLACEMENT_FAILURE_KIND = {
  "work-unresolved": "expected",
  "work-identity-invalid": "defect",
  "statute-not-loaded": "expected",
  "no-version-in-force": "expected",
  "version-not-stated": "expected",
  "sentence-unlocatable": "defect",
  "reference-unlocatable": "defect",
  "span-out-of-bounds": "defect",
  "span-overlap": "defect",
  "ambiguous-placement": "defect",
  "page-limit-reached": "expected",
} as const satisfies Record<
  ProvisionPlacementFailureReason,
  "defect" | "expected"
>;

export type ProvisionPlacementFailureKind =
  (typeof PROVISION_PLACEMENT_FAILURE_KIND)[ProvisionPlacementFailureReason];

export type ProvisionPlacementFailure = {
  id: string;
  reason: ProvisionPlacementFailureReason;
};
