import { panic } from "better-result";

import { getAuth } from "@/api/lib/auth";
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

/** Sign a verified user in (password-less email OTP), creating them if new. */
export const signInHuman = async (email: string): Promise<HumanBrowser> => {
  const auth = getAuth();
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const otp = readDevOtp(email);
  if (!otp) {
    panic("dev OTP not stashed; is env.isDev true under test?");
  }
  const signInRes = await auth.api.signInEmailOTP({
    body: { email, otp },
    asResponse: true,
  });
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
