/**
 * The web sign-in's backdrop (apps/web/src/routes/auth/route.tsx): the page
 * background down to 40%, then a blue toward the foot, per colour scheme.
 * `auth-backdrop.test.ts` holds these to the web's values.
 */
export const AUTH_GRADIENT_END = {
  light: "#cbe1fc",
  dark: "#1a3a5c",
} as const;

/** Where the background starts turning, as a fraction of the height. */
export const AUTH_GRADIENT_START = 0.4;

/** The terms every sign-in agrees to, as the web's sign-in links them. */
export const TERMS_URL = "https://stll.app/terms/";
