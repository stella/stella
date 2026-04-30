import type { FeatureFlag, FeatureFlagState } from "@stll/feature-flags";

import { env } from "@/env";

export const featureFlags = {
  chat: env.VITE_FEATURE_CHAT,
  billing: env.VITE_FEATURE_BILLING,
  knowledgeTemplates: env.VITE_FEATURE_KNOWLEDGE_TEMPLATES,
  caseLaw: env.VITE_FEATURE_CASE_LAW,
  contacts: env.VITE_FEATURE_CONTACTS,
  calendar: env.VITE_FEATURE_CALENDAR,
  todos: env.VITE_FEATURE_TODOS,
  mcp: env.VITE_FEATURE_MCP,
  desktopEditing: env.VITE_FEATURE_DESKTOP_EDITING,
} satisfies FeatureFlagState;

export const isFeatureEnabled = (feature: FeatureFlag): boolean =>
  featureFlags[feature];
