// Failures of the connection layer. Messages are for logs and tests; screens
// choose their copy from the error's tag, never from its message.
//
// Every module the API's end-to-end sign-in test imports uses relative
// imports only, so it resolves the same under the app and under the API.

import { TaggedError } from "better-result";

export class ServerUrlError extends TaggedError("ServerUrlError")<{
  message: string;
}> {}

export class DiscoveryError extends TaggedError("DiscoveryError")<{
  message: string;
  serverUrl: string;
}> {}

export class ClientRegistrationError extends TaggedError(
  "ClientRegistrationError",
)<{
  message: string;
  cause?: unknown;
}> {}

export type AuthorizationFailure =
  /** The person closed the browser before finishing. */
  | "cancelled"
  /** The person or the server refused the request. */
  | "denied"
  /** The callback does not answer this attempt: wrong state or issuer. */
  | "mismatched"
  /** The callback carried neither a code nor an error. */
  | "malformed";

export class AuthorizationError extends TaggedError("AuthorizationError")<{
  message: string;
  failure: AuthorizationFailure;
}> {}

export class TokenError extends TaggedError("TokenError")<{
  message: string;
  oauthError?: string | undefined;
  cause?: unknown;
}> {}

/** The stored session no longer works and the person has to sign in again. */
export class SignedOutError extends TaggedError("SignedOutError")<{
  message: string;
}> {}
