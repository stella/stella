/**
 * The JSON bodies of the auth library endpoints the browser specs answer, as
 * plain types. Loading the library's own endpoint types costs the specs'
 * project a sixth of its type work, so they stay out of it:
 * `auth-endpoint-bodies.type-test.ts` binds each body here to the library's
 * endpoint result in the web project, so a library upgrade that changes one
 * fails the web typecheck.
 */
export type AuthEndpointBodies = {
  "email-otp/send-verification-otp": { success: boolean };
  "organization/list": {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    logo?: string | null;
    metadata?: unknown;
  }[];
  /** The redirect answer; the specs never sign in with a provider token. */
  "sign-in/social": { url: string; redirect: boolean };
  "sign-out": { success: boolean; url?: string; redirect?: boolean };
};
