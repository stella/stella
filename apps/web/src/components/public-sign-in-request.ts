import { createContext, use } from "react";

/** Opens the public shell's sign-in dialog, returning to `redirectTo` after. */
export type RequestSignIn = (redirectTo: string) => void;

/**
 * Provided by the public workspace shell so content rendered inside it (the
 * inspector rail, a view's sign-in prompt) can ask for a session without
 * leaving the page. Null outside that shell.
 */
export const PublicSignInRequestContext = createContext<RequestSignIn | null>(
  null,
);

export const usePublicSignInRequest = (): RequestSignIn | null =>
  use(PublicSignInRequestContext);
