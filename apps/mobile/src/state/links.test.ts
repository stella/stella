import { describe, expect, test } from "bun:test";

import {
  MOBILE_APP_VARIANTS,
  MOBILE_REDIRECT_PATH,
  MOBILE_REDIRECT_SCHEMES,
} from "@stll/api-contract/mobile-client";

import { isWebUrl, openableLink } from "./links";

const SCHEME = MOBILE_REDIRECT_SCHEMES.production;

/** What a link opens as, without the marker only the module can write. */
const opensAs = (href: string, appScheme: string | undefined = SCHEME) => {
  const link = openableLink(href, appScheme);
  if (link === undefined) {
    return undefined;
  }
  return link.kind === "web"
    ? { kind: link.kind, url: link.url, host: link.host }
    : { kind: link.kind, url: link.url };
};

describe("web links", () => {
  test.each([
    ["https://nalus.usoud.cz/x?y=1#z", "nalus.usoud.cz"],
    ["http://usoud.cz", "usoud.cz"],
    ["https://stll.app:8443/a", "stll.app:8443"],
    ["https://127.0.0.1/a", "127.0.0.1"],
    ["https://x.test?q=a@b", "x.test"],
    ["https://x.test#a@b", "x.test"],
    ["https://x.test/zákon/§2?q=č", "x.test"],
  ])("%s opens on %s, as written", (href, host) => {
    expect(opensAs(href)).toEqual({ kind: "web", url: href, host });
  });

  test("reads the scheme in any case and ignores surrounding whitespace", () => {
    expect(opensAs("  HTTPS://Usoud.CZ/a \n")).toEqual({
      kind: "web",
      url: "https://usoud.cz/a",
      host: "usoud.cz",
    });
  });

  test("refuses anything before the host, which would hide where it goes", () => {
    expect(opensAs("https://stll.app@example.com/")).toBeUndefined();
    expect(opensAs("https://user:secret@example.com/")).toBeUndefined();
    expect(opensAs("https://stll.app\\@example.com/")).toBeUndefined();
  });

  test.each([
    "https://",
    "https:",
    "https:x.test",
    "https:/x.test",
    "https://:443/a",
    "https://.x.test",
    "https://x..test",
    "https://-x.test",
    "https://x.test:",
    "https://x.test:123456",
    "https://[::1]/a",
    "https://%65xample.com",
    // A name in another script shows as the letters it imitates; the link
    // stays readable as text.
    "https://ехample.com",
    "https://x.test/a b",
    "https://x.test/a\u0000",
  ])("%s has no host it can show plainly, so it does not open", (href) => {
    expect(opensAs(href)).toBeUndefined();
  });
});

describe("refused links", () => {
  test.each([
    // oxlint-disable-next-line no-script-url -- a link the rule must refuse.
    "javascript:alert(1)",
    // oxlint-disable-next-line no-script-url -- a link the rule must refuse.
    "JavaScript:alert(1)",
    " java\tscript:alert(1)",
    "data:text/html,<p>x</p>",
    "file:///etc/hosts",
    "tel:+420123456789",
    "sms:+420123456789?body=x",
    // A mail prefilled from document text: the address stays readable as
    // text, and the person can copy it.
    "mailto:office@example.com?subject=x",
    "ftp://usoud.cz",
    "intent://scan/#Intent;scheme=zxing;end",
    "whatsapp://send?text=x",
    // No page of their own: there is no base to resolve them against.
    "//example.com/a",
    "/matters/1",
    "matters/1",
    "#heading",
    "",
    "   ",
  ])("%s does not open", (href) => {
    expect(openableLink(href, SCHEME)).toBeUndefined();
  });
});

describe("the app's own links", () => {
  test("open this build's own screen", () => {
    expect(opensAs(`${SCHEME}:/timers`)).toEqual({
      kind: "app",
      url: `${SCHEME}:/timers`,
    });
    expect(opensAs(`${SCHEME.toUpperCase()}://matter/1`)).toEqual({
      kind: "app",
      url: `${SCHEME}://matter/1`,
    });
  });

  test("never another build's, nor any where app links have no place", () => {
    for (const variant of MOBILE_APP_VARIANTS) {
      const scheme = MOBILE_REDIRECT_SCHEMES[variant];
      for (const other of MOBILE_APP_VARIANTS.filter((v) => v !== variant)) {
        expect(
          openableLink(`${MOBILE_REDIRECT_SCHEMES[other]}:/timers`, scheme),
        ).toBeUndefined();
      }
    }
    expect(openableLink(`${SCHEME}:/timers`, undefined)).toBeUndefined();
  });

  test.each([
    `${SCHEME}:${MOBILE_REDIRECT_PATH}?code=x&state=y`,
    `${SCHEME}:/${MOBILE_REDIRECT_PATH}?code=x`,
    `${SCHEME}:/${MOBILE_REDIRECT_PATH.slice(1)}?code=x`,
    `${SCHEME}://${MOBILE_REDIRECT_PATH.slice(1)}?code=x`,
    `${SCHEME}://${MOBILE_REDIRECT_PATH.slice(1).toUpperCase()}`,
  ])("never the sign-in redirect: %s", (href) => {
    // The fixture must name the redirect for the refusal to mean anything.
    expect(href.toLowerCase()).toContain(MOBILE_REDIRECT_PATH.slice(1));
    expect(openableLink(href, SCHEME)).toBeUndefined();
  });
});

describe("isWebUrl", () => {
  test("is the web half of the same rule", () => {
    expect(isWebUrl(" HTTPS://usoud.cz ")).toBe(true);
    expect(isWebUrl("http://usoud.cz")).toBe(true);
    expect(isWebUrl("mailto:a@usoud.cz")).toBe(false);
    expect(isWebUrl("ftp://usoud.cz")).toBe(false);
    expect(isWebUrl("https://")).toBe(false);
    expect(isWebUrl(`${SCHEME}:/timers`)).toBe(false);
  });
});
