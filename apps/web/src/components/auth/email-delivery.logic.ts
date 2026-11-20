import { SIGN_IN_ATTEMPT_HEADER } from "@stll/api-contract/email-delivery";

const SIGN_IN_ATTEMPT_BYTES = 32;

/**
 * A fresh random id for one code request. The request carries it, and only
 * a caller holding it can later ask whether that request's code mail
 * bounced.
 */
export const newSignInAttempt = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(SIGN_IN_ATTEMPT_BYTES));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
};

/** The request headers that name a code request's attempt. */
export const signInAttemptHeaders = (attempt: string) => ({
  [SIGN_IN_ATTEMPT_HEADER]: attempt,
});

/** The domain part of an address, as a recipient's mail server serves it. */
export const emailDomain = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1);
