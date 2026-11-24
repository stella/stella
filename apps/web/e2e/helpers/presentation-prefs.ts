import type { BrowserContext } from "@playwright/test";

import {
  DECISION_LAYOUT_COOKIE,
  decisionLayoutsCookieSchema,
  parsePresentationPrefs,
  PRESENTATION_PREFS_COOKIE,
  serializePresentationPrefs,
  serializeTableLayoutCookie,
  STATUTE_LAYOUT_COOKIE,
  statuteLayoutsCookieSchema,
} from "../../src/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "../../src/lib/account/presentation-prefs/preferences";

type PresentationPrefsCookie = {
  httpOnly: boolean;
  prefs: PresentationPrefs;
};

/**
 * Every preference write rewrites the whole cookie, so a test waiting for one
 * write compares the value it wrote: the cookie's presence only proves that
 * some write, possibly an unrelated one, has landed.
 */
export const readPresentationPrefsCookie = async (
  context: BrowserContext,
  url: string,
): Promise<PresentationPrefsCookie | null> => {
  const cookie = (await context.cookies(url)).find(
    (entry) => entry.name === PRESENTATION_PREFS_COOKIE,
  );
  return cookie === undefined
    ? null
    : {
        httpOnly: cookie.httpOnly,
        prefs: parsePresentationPrefs(decodeURIComponent(cookie.value)),
      };
};

type SetPresentationPrefsOptions = {
  context: BrowserContext;
  url: string;
  patch: Partial<PresentationPrefs>;
};

export const setPresentationPrefs = async ({
  context,
  url,
  patch,
}: SetPresentationPrefsOptions) => {
  const cookie = await readPresentationPrefsCookie(context, url);
  const cookieOptions = {
    url: new URL("/", url).href,
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: new URL(url).protocol === "https:",
  };
  const cookies = [
    {
      ...cookieOptions,
      name: PRESENTATION_PREFS_COOKIE,
      value: encodeURIComponent(
        serializePresentationPrefs({
          ...(cookie?.prefs ?? parsePresentationPrefs(undefined)),
          ...patch,
        }),
      ),
    },
  ];
  if (patch.decisionLayouts !== undefined) {
    cookies.push({
      ...cookieOptions,
      name: DECISION_LAYOUT_COOKIE,
      value: encodeURIComponent(
        serializeTableLayoutCookie(
          patch.decisionLayouts,
          decisionLayoutsCookieSchema,
        ),
      ),
    });
  }
  if (patch.statuteLayouts !== undefined) {
    cookies.push({
      ...cookieOptions,
      name: STATUTE_LAYOUT_COOKIE,
      value: encodeURIComponent(
        serializeTableLayoutCookie(
          patch.statuteLayouts,
          statuteLayoutsCookieSchema,
        ),
      ),
    });
  }
  await context.addCookies(cookies);
};
