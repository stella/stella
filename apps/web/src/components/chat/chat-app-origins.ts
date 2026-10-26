import { env } from "@/env";

/** Origins whose `/law` links are Stella pages: the configured app URL and,
 *  in the browser, the page's own origin. A relative link in an answer
 *  resolves against the first. */
export const chatAppOrigins = (): ReadonlySet<string> =>
  new Set([
    new URL(env.VITE_PUBLIC_APP_URL).origin,
    ...(typeof window === "undefined" ? [] : [window.location.origin]),
  ]);
