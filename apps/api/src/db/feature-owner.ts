const FEATURE_OWNER = {
  shared: "shared",
  flows: "flows",
  unknown: "unknown",
} as const;

export const ENTITY_FEATURE_OWNERS = [
  FEATURE_OWNER.shared,
  FEATURE_OWNER.flows,
] as const;
export const RETAINED_ACTIVITY_FEATURE_OWNERS = [
  ...ENTITY_FEATURE_OWNERS,
  FEATURE_OWNER.unknown,
] as const;
export type EntityFeatureOwner = (typeof ENTITY_FEATURE_OWNERS)[number];
export type RetainedActivityFeatureOwner =
  (typeof RETAINED_ACTIVITY_FEATURE_OWNERS)[number];
