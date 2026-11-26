/**
 * The desktop features in the one order every surface lists them in: the
 * setup tour's overview and its steps, the Settings sidebar and the tray
 * menu. `fixtures/desktop-feature-order.json` holds the same list for the
 * native tray menu and setup flow; `tests/desktop-feature-order.test.ts`
 * fails when a surface lists them in another order.
 */
export const DESKTOP_FEATURES = [
  "documents",
  "clipboard",
  "signing",
  "dictation",
  "activity",
] as const;

export type DesktopFeature = (typeof DESKTOP_FEATURES)[number];
