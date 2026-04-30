import type { FeatureFlag, FeatureFlagState } from "@stll/feature-flags";

import { env } from "@/api/env";

export const featureFlags = {
  chat: env.FEATURE_CHAT,
  billing: env.FEATURE_BILLING,
  knowledgeTemplates: env.FEATURE_KNOWLEDGE_TEMPLATES,
  caseLaw: env.FEATURE_CASE_LAW,
  contacts: env.FEATURE_CONTACTS,
  calendar: env.FEATURE_CALENDAR,
  todos: env.FEATURE_TODOS,
  mcp: env.FEATURE_MCP,
  desktopEditing: env.FEATURE_DESKTOP_EDITING,
} satisfies FeatureFlagState;

export const isFeatureEnabled = (feature: FeatureFlag): boolean =>
  featureFlags[feature];
