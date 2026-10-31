export const PRODUCT_FRONTEND_FILES = [
  "apps/web/src/**/*.{ts,tsx}",
  "packages/mcp-apps/src/**/*.{ts,tsx}",
] as const;

/**
 * Every surface that renders through `@stll/ui`, and so must not hand-roll the
 * native markup one of its components wraps (`no-native-ui` in
 * oxlint.config.ts). `.oxlint-plugins/__tests__/no-native-ui-registry.test.ts`
 * holds it to the workspaces that depend on `@stll/ui`. Outside it by design:
 * packages/ui renders that markup, apps/mobile renders React Native views
 * (`REACT_NATIVE_CONSUMER_FILES` below), and apps/api and
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
 * Every surface that renders React Native through `@stll/ui`'s native
 * renderers, and so must not render the React Native component one of them
 * replaces (a raw Pressable, ActivityIndicator, Modal). It takes only the
 * `no-native-ui` rules of components that have a native renderer: a rule for a
 * web-only component would name a replacement the app cannot import.
 */
export const REACT_NATIVE_CONSUMER_FILES = [
  "apps/mobile/src/**/*.{ts,tsx}",
] as const;
