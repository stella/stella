// Which links in text the app did not write (a chat answer, a decision's
// source) may open, and how. The one owner of that decision: the markdown
// parser makes a link span only from a link this module accepts, and only
// `components/open-link.ts` opens one (`architecture.test.ts` holds every
// other module to that).
//
// Accepted:
// - web pages, `https:` and `http:`, whose host is a plain ASCII name or
//   address with an optional port. Nothing may stand before the host
//   (`https://stll.app@example.com` reads as stella and goes to
//   example.com). The person sees the host before one opens.
// - this build's own scheme (`app.stll:/timers`), which opens the app's own
//   screen directly; never its sign-in redirect, which only the sign-in
//   flow may receive.
//
// Everything else stays text: `javascript:`, `data:`, `file:`, `tel:` and
// `sms:` (a call or a message prefilled from document text), `mailto:` (a
// mail prefilled the same way; the address itself stays readable and
// copyable), other apps' schemes, other stella builds' schemes,
// protocol-relative (`//host`) and relative links, which have no page of
// their own to go to, and any link with spaces, control characters or
// backslashes inside, which browsers and the system each read differently.
//
// Scanned by hand, not with `URL`: React Native's `URL` reads addresses
// with its own regular expressions, unlike the WHATWG parser tests run
// under, so a rule built on it would hold in tests and differ on the phone.

import { MOBILE_REDIRECT_PATH } from "@stll/api-contract/mobile-client";

const ACCEPTED: unique symbol = Symbol("accepted link");

/**
 * A link that may open. Only `openableLink` makes one: the marker it
 * carries cannot be written anywhere else.
 */
export type OpenableLink =
  | {
      readonly kind: "web";
      /** The link with its scheme and host in lower case. */
      readonly url: string;
      /** Where it goes, shown to the person before it opens. */
      readonly host: string;
      readonly [ACCEPTED]: true;
    }
  | {
      readonly kind: "app";
      readonly url: string;
      readonly [ACCEPTED]: true;
    };

/** RFC 3986 §3.1. */
const SCHEME = /^([a-z][\d+.a-z-]*):/iu;

/** Spaces, controls, backslashes: read differently by different parsers. */
const AMBIGUOUS = /[\s\p{Cc}\\]/u;

/** A DNS name or IPv4 address in ASCII, then an optional port. */
const HOST =
  /^[\da-z](?:[\da-z-]*[\da-z])?(?:\.[\da-z](?:[\da-z-]*[\da-z])?)*(?::\d{1,5})?$/u;

/**
 * The link `href` names when it may open, else undefined. `appScheme` is
 * this build's own scheme (`MOBILE_REDIRECT_SCHEMES`), or undefined where
 * app links have no place.
 */
export const openableLink = (
  href: string,
  appScheme: string | undefined,
): OpenableLink | undefined => {
  const link = href.trim();
  const scheme = SCHEME.exec(link)?.[1]?.toLowerCase();
  if (scheme === undefined || AMBIGUOUS.test(link)) {
    return undefined;
  }
  const rest = link.slice(scheme.length + 1);
  if (scheme === "https" || scheme === "http") {
    if (!rest.startsWith("//")) {
      return undefined;
    }
    const authorityEnd = rest.slice(2).search(/[#/?]/u);
    const authority = rest.slice(
      2,
      authorityEnd === -1 ? undefined : authorityEnd + 2,
    );
    const host = authority.toLowerCase();
    if (!HOST.test(host)) {
      return undefined;
    }
    return {
      kind: "web",
      url: `${scheme}://${host}${rest.slice(2 + authority.length)}`,
      host,
      [ACCEPTED]: true,
    };
  }
  if (scheme === appScheme?.toLowerCase() && !isRedirect(rest)) {
    return { kind: "app", url: `${scheme}:${rest}`, [ACCEPTED]: true };
  }
  return undefined;
};

/**
 * Whether what follows an app link's scheme names the sign-in redirect,
 * written any way the router would still read it: `:/oauth/callback`,
 * `://oauth/callback`, doubled slashes or other casing.
 */
const isRedirect = (rest: string): boolean => {
  const end = rest.search(/[#?]/u);
  return `/${rest.slice(0, end === -1 ? undefined : end)}/`
    .replace(/\/+/gu, "/")
    .toLowerCase()
    .startsWith(`${MOBILE_REDIRECT_PATH}/`);
};

/** Whether `url` is a web page this module would open. */
export const isWebUrl = (url: string): boolean =>
  openableLink(url, undefined)?.kind === "web";
