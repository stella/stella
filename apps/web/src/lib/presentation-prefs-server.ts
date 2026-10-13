import { createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import * as v from "valibot";

import type { PresentationPrefs } from "@/lib/presentation-prefs";
import {
  parsePresentationPrefs,
  parseTableLayoutCookie,
  DECISION_LAYOUT_COOKIE,
  STATUTE_LAYOUT_COOKIE,
  decisionLayoutsCookieSchema,
  statuteLayoutsCookieSchema,
  corePresentationPrefsSchema,
  PRESENTATION_PREFS_COOKIE,
  presentationPrefsSchema,
  serializePresentationPrefs,
  serializeTableLayoutCookie,
} from "@/lib/presentation-prefs";

const patchSchema = v.strictObject({
  ...v.partial(corePresentationPrefsSchema).entries,
  decisionLayouts: v.optional(decisionLayoutsCookieSchema),
  statuteLayouts: v.optional(statuteLayoutsCookieSchema),
});

const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const readPrefs = () => ({
  ...parsePresentationPrefs(getCookie(PRESENTATION_PREFS_COOKIE)),
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
});

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
