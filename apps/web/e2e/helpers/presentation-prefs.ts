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
  const cookie = (await context.cookies(url)).find(
    (entry) => entry.name === PRESENTATION_PREFS_COOKIE,
  );
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
          ...parsePresentationPrefs(
            cookie === undefined ? undefined : decodeURIComponent(cookie.value),
          ),
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
