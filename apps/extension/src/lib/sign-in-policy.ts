import {
  BROWSER_CONTROL_ERROR_CODE,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";

import { browserControlError } from "./browser-control-result";

/**
 * How a command treats a page that asks for a sign-in: a password or
 * one-time-code field, or an identity provider's page. The transport picks
 * it; the page script and the worker both apply it.
 */
export const SIGN_IN_POLICY = {
  /** stella desktop: the member signs in; the page is not read or acted on. */
  handToMember: "hand-to-member",
  /** A web connection: the page is read with its secret fields withheld. */
  withholdSecrets: "withhold-secrets",
} as const;

export type SignInPolicy = (typeof SIGN_IN_POLICY)[keyof typeof SIGN_IN_POLICY];

/**
 * Hosts whose pages are identity providers' sign-in and consent screens: a
 * page on one is the member's to complete, whatever fields it shows. A
 * leading dot matches the host's subdomains (tenant sign-in pages), never
 * the bare domain. The page script gets the list too and matches each frame
 * the same way, for a provider's page embedded in another.
 */
export const IDENTITY_PROVIDER_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "appleid.apple.com",
  "idmsa.apple.com",
  ".okta.com",
  ".oktapreview.com",
  ".okta-emea.com",
  ".auth0.com",
  ".onelogin.com",
  ".pingone.com",
  ".pingone.eu",
  ".duosecurity.com",
  ".b2clogin.com",
  ".amazoncognito.com",
] as const;

const hostMatches = (host: string, pattern: string): boolean =>
  pattern.startsWith(".")
    ? host.endsWith(pattern) && host.length > pattern.length
    : host === pattern;

/** Whether `rawUrl` is an identity provider's page; false when it is no URL. */
export const isIdentityProviderUrl = (rawUrl: string): boolean => {
  const url = URL.parse(rawUrl);
  if (url === null) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return IDENTITY_PROVIDER_HOSTS.some((pattern) => hostMatches(host, pattern));
};

/**
 * What a command gets on a page that asks for a sign-in. Nothing on the page
 * was read, typed or clicked, and no snapshot was stored.
 */
export const SIGN_IN_MESSAGE =
  "This page asks for a sign-in. The member signs in themselves: ask them to sign in in this tab, then take a snapshot again. Do not try to fill in sign-in or verification fields.";

export const needsMember = (): BrowserControlResult =>
  browserControlError(BROWSER_CONTROL_ERROR_CODE.needsMember, SIGN_IN_MESSAGE);
