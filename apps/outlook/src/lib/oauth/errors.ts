// Failures of the add-in's OAuth client. Messages are for logs and tests; the
// task pane picks its copy from the failure kind, never from the message.

import { TaggedError } from "better-result";

export type SignInFailure =
  /** The Office host cannot open a secure sign-in dialog. */
  | "unsupported"
  /** The authorization server or its client registration is unavailable. */
  | "unavailable"
  /** The person closed the dialog before finishing. */
  | "cancelled"
  /** The person or the server refused the request. */
  | "denied"
  /** The callback does not answer this attempt: wrong origin, state or issuer. */
  | "mismatched"
  /** The callback carried neither a code nor an error. */
  | "malformed"
  /** The code exchange failed. */
  | "token";

export class SignInError extends TaggedError("SignInError")<{
  message: string;
  failure: SignInFailure;
  cause?: unknown;
}> {}

export class TokenError extends TaggedError("TokenError")<{
  message: string;
  oauthError?: string | undefined;
  /** The token endpoint's HTTP status, when it answered with a refusal. */
  status?: number | undefined;
  cause?: unknown;
}> {}
