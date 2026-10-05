import type { FeatureAccessState } from "@/queries/feature-access";

export type FeatureAccessPrincipal = { organizationId: string; userId: string };

export const featureIsEnabled = (
  state: FeatureAccessState | undefined,
  { organizationId, userId }: FeatureAccessPrincipal,
  featureId: string,
): boolean =>
  state?.organizationId === organizationId &&
  state.userId === userId &&
  state.enabledFeatures.includes(featureId);
