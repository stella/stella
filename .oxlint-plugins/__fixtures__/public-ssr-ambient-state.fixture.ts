// Passive regression fixture for the native public SSR ambient-state rules.

// oxlint-disable-next-line no-restricted-globals -- fixture: browser globals need a hydration-safe adapter
export const browserLocale = navigator.language;
// oxlint-disable-next-line no-restricted-globals -- fixture: global-object access is covered too
export const persistedTheme = globalThis.localStorage.getItem("theme");
// oxlint-disable-next-line no-restricted-properties -- fixture: render-time clocks are ambient
export const openedAt = Date.now();
// oxlint-disable-next-line no-restricted-properties -- fixture: date parsing belongs behind an owned deterministic parser
export const parsedAt = Date.parse("2026-08-13");
// oxlint-disable-next-line no-restricted-properties -- fixture: random render state is ambient
export const randomWidth = Math.random();
// oxlint-disable-next-line no-restricted-properties -- fixture: browser entropy differs across renders
export const randomId = crypto.randomUUID();
// oxlint-disable-next-line no-restricted-properties -- fixture: performance clocks differ across renders
export const measuredAt = performance.now();
// oxlint-disable-next-line no-restricted-properties -- fixture: implicit host locale and time zone are ambient
export const formatter = new Intl.DateTimeFormat();

// Allowed: lexical locals with the same names are not ambient globals.
export const readLocalWindow = (window: { value: string }) => window.value;
export const readLocalNavigator = (navigator: { language: string }) =>
  navigator.language;
