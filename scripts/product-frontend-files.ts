export const PRODUCT_FRONTEND_FILES = [
  "apps/web/src/**/*.{ts,tsx}",
  "packages/mcp-apps/src/**/*.{ts,tsx}",
] as const;

/**
 * Every surface that renders through `@stll/ui`, and so must not hand-roll the
 * native markup one of its components wraps (`no-native-ui` in
 * oxlint.config.ts). `.oxlint-plugins/__tests__/no-native-ui-registry.test.ts`
 * holds it to the workspaces that depend on `@stll/ui`, less the ones listed
 * below. Also outside it: packages/ui renders that markup, and apps/api and
 * packages/transactional render email markup for mail clients.
 */
export const DESIGN_SYSTEM_CONSUMER_FILES = [
  ...PRODUCT_FRONTEND_FILES,
  "apps/desktop/src/**/*.{ts,tsx}",
  "apps/landing/src/**/*.{ts,tsx}",
  "apps/playground/src/**/*.{ts,tsx}",
  "packages/chat/src/**/*.{ts,tsx}",
  "packages/decision-reader/src/**/*.{ts,tsx}",
  "packages/workspace-ui/src/**/*.{ts,tsx}",
] as const;

/**
 * Workspaces that depend on `@stll/ui` without rendering its components, and
 * why. Every other dependent must be in DESIGN_SYSTEM_CONSUMER_FILES.
 */
export const DESIGN_SYSTEM_TOKEN_ONLY_WORKSPACES: Readonly<
  Record<string, string>
> = {
  "apps/mobile":
    "React Native views read the design tokens; the DOM components cannot render there",
};
