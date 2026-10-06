/**
 * Feature-access facts a member authorization carries, for fakes of the
 * member lookup that are not about feature access: a verified member with no
 * enrolments.
 */
export const NO_FEATURE_ACCESS_FACTS = {
  emailVerified: true,
  userDeleted: false,
  enrolledFeatureIds: [],
} as const;
