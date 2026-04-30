export const featureFlagKeys = [
  "chat",
  "billing",
  "knowledgeTemplates",
  "caseLaw",
  "contacts",
  "calendar",
  "todos",
  "mcp",
  "desktopEditing",
] as const;

export type FeatureFlag = (typeof featureFlagKeys)[number];

export type FeatureFlagState = Record<FeatureFlag, boolean>;

export const isKnownFeatureFlag = (value: string): value is FeatureFlag =>
  featureFlagKeys.some((flag) => flag === value);
