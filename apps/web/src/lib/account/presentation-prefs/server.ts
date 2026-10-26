import { createServerFn } from "@tanstack/react-start";
import {
  getCookie,
  getRequestHeader,
  setCookie,
} from "@tanstack/react-start/server";
import * as v from "valibot";

import { SIDEBAR_STATE_COOKIE } from "@/components/sidebar/sidebar-state-cookie";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import {
  corePresentationPrefsSchema,
  DECISION_LAYOUT_COOKIE,
  decisionLayoutsCookieSchema,
  parsePresentationPrefsWithLegacySidebar,
  parseTableLayoutCookie,
  PRESENTATION_PREFS_COOKIE,
  presentationPrefsSchema,
  serializePresentationPrefs,
  serializeTableLayoutCookie,
  STATUTE_LAYOUT_COOKIE,
  statuteLayoutsCookieSchema,
} from "@/lib/account/presentation-prefs/preferences";

const patchSchema = v.strictObject({
  ...v.partial(corePresentationPrefsSchema).entries,
  decisionLayouts: v.optional(decisionLayoutsCookieSchema),
  statuteLayouts: v.optional(statuteLayoutsCookieSchema),
});

const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const readPrefs = () => {
  // Remove this fallback one year after cutover, when old cookies have expired.
  const prefs = parsePresentationPrefsWithLegacySidebar({
    prefsCookie: getCookie(PRESENTATION_PREFS_COOKIE),
    legacySidebarCookie: getCookie(SIDEBAR_STATE_COOKIE),
    acceptLanguage: getRequestHeader("accept-language"),
  });
  return {
    ...prefs,

    decisionLayouts:
      parseTableLayoutCookie(
        getCookie(DECISION_LAYOUT_COOKIE),
        decisionLayoutsCookieSchema,
      ) ?? {},
    statuteLayouts:
      parseTableLayoutCookie(
        getCookie(STATUTE_LAYOUT_COOKIE),
        statuteLayoutsCookieSchema,
      ) ?? {},
  };
};

export const readPresentationPrefs = createServerFn({ method: "GET" }).handler(
  () => readPrefs(),
);

export const writePresentationPrefs = createServerFn({ method: "POST" })
  .validator((input: Partial<PresentationPrefs>) => v.parse(patchSchema, input))
  .handler(({ data }) => {
    const prefs = v.parse(presentationPrefsSchema, {
      ...readPrefs(),
      ...data,
    });
    setCookie(PRESENTATION_PREFS_COOKIE, serializePresentationPrefs(prefs), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: import.meta.env.PROD,
      maxAge: COOKIE_MAX_AGE,
    });
    // A new unified preference supersedes the earlier sidebar-only cookie.
    setCookie(SIDEBAR_STATE_COOKIE, "", {
      path: "/",
      sameSite: "lax",
      maxAge: 0,
    });
    if (data.decisionLayouts !== undefined) {
      setCookie(
        DECISION_LAYOUT_COOKIE,
        serializeTableLayoutCookie(
          prefs.decisionLayouts,
          decisionLayoutsCookieSchema,
        ),
        {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: import.meta.env.PROD,
          maxAge: COOKIE_MAX_AGE,
        },
      );
    }
    if (data.statuteLayouts !== undefined) {
      setCookie(
        STATUTE_LAYOUT_COOKIE,
        serializeTableLayoutCookie(
          prefs.statuteLayouts,
          statuteLayoutsCookieSchema,
        ),
        {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: import.meta.env.PROD,
          maxAge: COOKIE_MAX_AGE,
        },
      );
    }
    return prefs;
  });
