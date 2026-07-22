import { TaggedError } from "better-result";

export class MobileAuthError extends TaggedError("MobileAuthError")<{
  message: string;
}>() {}

export const isTwoFactorRedirect = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  return "twoFactorRedirect" in data && data.twoFactorRedirect === true;
};

export const authErrorMessage = (error: unknown, fallback: string) => {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return fallback;
  }
  const message = error.message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : fallback;
};

export const toMobileAuthError = (error: unknown, fallback: string) =>
  new MobileAuthError({ message: authErrorMessage(error, fallback) });
