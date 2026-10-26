import { panic } from "better-result";
import * as v from "valibot";

import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";

import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { readDevOtp } from "@/api/lib/dev-otp-store";

const responseCookiePairs = (res: Response): [string, string][] =>
  (res.headers.get("set-cookie") ?? "")
    .split(",")
    .map((part) => part.split(";").at(0)?.trim() ?? "")
    .filter((part) => part.includes("="))
    .map((part) => {
      const separator = part.indexOf("=");
      return [part.slice(0, separator), part.slice(separator + 1)];
    });

/**
 * A signed-in browser: its cookie jar and the auth calls that change what the
 * jar holds.
 *
 * Cookies live in a jar, not a fixed header: auth mutations reissue the
 * signed session_data snapshot (cookieCache), and getSession serves that
 * snapshot in preference to a database read. A fixed header captured at
 * sign-in would keep serving the pre-set-active session forever. Browsers
 * adopt the refreshed cookie automatically; the jar mirrors that.
 */
export type HumanBrowser = {
  email: string;
  userId: string;
  cookieHeader: () => string;
  headers: () => Headers;
  setActiveOrganization: (organizationId: string) => Promise<void>;
};

type SignInHumanOptions = {
  /**
   * The professional-use statement version the sign-in page displayed, as
   * the web client sends it; `null` sends none. Decides whether a new
   * account is created accepted.
   */
  displayedStatementVersion: string | null;
};

/** The browser a sign-in response leaves behind: its cookies and session. */
const toHumanBrowser = async (
  email: string,
  signInRes: Response,
): Promise<HumanBrowser> => {
  const auth = getAuth();
  const jar = new Map(responseCookiePairs(signInRes));
  const cookieHeader = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const headers = () => new Headers({ cookie: cookieHeader() });
  const session = await auth.api.getSession({ headers: headers() });
  if (!session?.user) {
    panic("sign-in produced no session");
  }
  return {
    email,
    userId: session.user.id,
    cookieHeader,
    headers,
    setActiveOrganization: async (organizationId) => {
      const setActiveRes = await auth.api.setActiveOrganization({
        body: { organizationId },
        headers: headers(),
        asResponse: true,
      });
      if (!setActiveRes.ok) {
        panic(`setActiveOrganization failed: ${String(setActiveRes.status)}`);
      }
      for (const [name, value] of responseCookiePairs(setActiveRes)) {
        jar.set(name, value);
      }
    },
  };
};

/** Sign a verified user in (password-less email OTP), creating them if new. */
export const signInHuman = async (
  email: string,
  options?: SignInHumanOptions,
): Promise<HumanBrowser> => {
  // The web client names the version its sign-in page displays.
  const displayedStatementVersion =
    options === undefined
      ? PROFESSIONAL_USE_STATEMENT_VERSION
      : options.displayedStatementVersion;
  const auth = getAuth();
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const otp = readDevOtp(email);
  if (!otp) {
    panic(
      "dev OTP not stashed; run the suite through `bun run test`, which opts into local development access.",
    );
  }
  const signInRes = await auth.api.signInEmailOTP({
    body:
      displayedStatementVersion === null
        ? { email, otp }
        : {
            email,
            otp,
            [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
              displayedStatementVersion,
          },
    asResponse: true,
  });
  return await toHumanBrowser(email, signInRes);
};

type SignInHumanFromOAuthPageOptions = {
  email: string;
  /** The signed request the sign-in page received. */
  oauthQuery: string;
  /** The browser as it reached the page, with whatever session it held. */
  prior: HumanBrowser;
};

const oauthRedirectSchema = v.looseObject({ url: v.string() });

/**
 * Sign in on the OAuth sign-in page, as the web page posts it: the signed
 * request rides along, and the provider answers with where the
 * authorization continues for the account that signed in.
 */
export const signInHumanFromOAuthPage = async ({
  email,
  oauthQuery,
  prior,
}: SignInHumanFromOAuthPageOptions): Promise<{
  browser: HumanBrowser;
  redirect: URL;
}> => {
  const auth = getAuth();
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const otp =
    readDevOtp(email) ??
    panic(
      "dev OTP not stashed; run the suite through `bun run test`, which opts into local development access.",
    );
  const address = `203.0.113.${String(Math.floor(Math.random() * 254) + 1)}`;
  const signInRes = await auth.handler(
    new Request(getAuthEndpointUrl("sign-in/email-otp"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: prior.cookieHeader(),
        "x-forwarded-for": address,
        [AUTH_CLIENT_ADDRESS_HEADER]: address,
      },
      body: JSON.stringify({
        email,
        otp,
        [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
          PROFESSIONAL_USE_STATEMENT_VERSION,
        oauth_query: oauthQuery,
      }),
    }),
  );
  const answer = v.parse(oauthRedirectSchema, await signInRes.clone().json());
  return {
    browser: await toHumanBrowser(email, signInRes),
    redirect: new URL(answer.url),
  };
};

type CreateHumanSessionOptions = {
  email: string;
  orgName: string;
  orgSlugPrefix: string;
};

/**
 * Create a verified user (password-less email OTP), an org, and an active
 * session cookie header.
 */
export const createHumanSession = async ({
  email,
  orgName,
  orgSlugPrefix,
}: CreateHumanSessionOptions) => {
  const auth = getAuth();
  const browser = await signInHuman(email);
  const org = await auth.api.createOrganization({
    body: { name: orgName, slug: `${orgSlugPrefix}-${Bun.randomUUIDv7()}` },
    headers: browser.headers(),
  });
  await browser.setActiveOrganization(org.id);
  const session = await auth.api.getSession({ headers: browser.headers() });
  if (!session?.user || !session.session.activeOrganizationId) {
    panic("session not active for org");
  }
  return {
    browser,
    cookieHeader: browser.cookieHeader(),
    email,
    userId: session.user.id,
    organizationId: session.session.activeOrganizationId,
  };
};
