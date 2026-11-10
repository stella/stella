// The authorization request and its answer, as they cross the Office dialog:
//
//   task pane ── displayDialogAsync ──► /auth/start.html?authorize=<url>
//   /auth/start.html ── navigates ──► the authorization endpoint (sign-in,
//     organization and consent pages run inside the dialog)
//   authorization server ── redirects ──► /auth/callback.html?code&state&iss
//   /auth/callback.html ── messageParent(targetOrigin = own origin) ──► task pane
//
// The dialog pages hold no secret: the PKCE verifier never leaves the task
// pane, and the callback forwards only the authorization response fields.

import { Result } from "better-result";
import * as v from "valibot";

import {
  OUTLOOK_SCOPES,
  outlookRedirectUri,
} from "@stll/api-contract/outlook-client";

import { SignInError } from "@/lib/oauth/errors";

export const OUTLOOK_AUTH_START_PATH = "/auth/start.html" as const;
const AUTHORIZE_PARAMETER = "authorize";

export const OUTLOOK_AUTH_CALLBACK_MESSAGE_TYPE =
  "stella:outlook-authorization-response" as const;

/** Upper bound for each forwarded field, far above any real value. */
const MAX_FIELD_LENGTH = 4096;

export const buildAuthorizeUrl = ({
  authorizationEndpoint,
  clientId,
  codeChallenge,
  redirectUri,
  resource,
  state,
}: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly codeChallenge: string;
  /** `outlookRedirectUri(taskPaneOrigin)`. */
  readonly redirectUri: string;
  /** `apiOAuthResourceUrl(apiOrigin)` (RFC 8707). */
  readonly resource: string;
  readonly state: string;
}): string => {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", resource);
  url.searchParams.set("scope", OUTLOOK_SCOPES.join(" "));
  // A public client is asked for consent on every grant anyway; asking up
  // front keeps the dialog to one pass.
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

/** The dialog's first page, on the task pane's own origin as Office requires. */
export const buildDialogStartUrl = ({
  authorizeUrl,
  taskPaneOrigin,
}: {
  readonly authorizeUrl: string;
  readonly taskPaneOrigin: string;
}): string => {
  const url = new URL(OUTLOOK_AUTH_START_PATH, taskPaneOrigin);
  url.searchParams.set(AUTHORIZE_PARAMETER, authorizeUrl);
  return url.toString();
};

/**
 * Where the start page may send the dialog: an authorization request on one
 * of the configured stella origins, and nowhere else, so the page cannot be
 * used to redirect to another site.
 */
export const readDialogStartTarget = ({
  allowedOrigins,
  location,
}: {
  readonly allowedOrigins: readonly string[];
  readonly location: string;
}): string | null => {
  const start = URL.parse(location);
  const raw = start?.searchParams.get(AUTHORIZE_PARAMETER);
  const target = raw ? URL.parse(raw) : null;
  if (
    target === null ||
    !allowedOrigins.includes(target.origin) ||
    target.username !== "" ||
    target.password !== "" ||
    target.searchParams.get("response_type") !== "code" ||
    target.searchParams.get("code_challenge_method") !== "S256" ||
    // Only back to this task pane's own callback.
    start === null ||
    target.searchParams.get("redirect_uri") !== outlookRedirectUri(start.origin)
  ) {
    return null;
  }
  return target.toString();
};

const boundedString = v.pipe(v.string(), v.maxLength(MAX_FIELD_LENGTH));

const callbackMessageSchema = v.object({
  type: v.literal(OUTLOOK_AUTH_CALLBACK_MESSAGE_TYPE),
  code: v.nullable(boundedString),
  error: v.nullable(boundedString),
  iss: v.nullable(boundedString),
  state: v.nullable(boundedString),
});

export type AuthorizationCallbackMessage = v.InferOutput<
  typeof callbackMessageSchema
>;

const boundedParameter = (
  parameters: URLSearchParams,
  name: string,
): string | null => {
  const value = parameters.get(name);
  return value === null ? null : value.slice(0, MAX_FIELD_LENGTH);
};

/**
 * What the callback page forwards to the task pane: the authorization
 * response fields and nothing else from its address.
 */
export const buildCallbackMessage = (callbackUrl: string): string => {
  const parameters = URL.parse(callbackUrl)?.searchParams ?? null;
  const message: AuthorizationCallbackMessage = {
    type: OUTLOOK_AUTH_CALLBACK_MESSAGE_TYPE,
    code: parameters ? boundedParameter(parameters, "code") : null,
    error: parameters ? boundedParameter(parameters, "error") : null,
    iss: parameters ? boundedParameter(parameters, "iss") : null,
    state: parameters ? boundedParameter(parameters, "state") : null,
  };
  return JSON.stringify(message);
};

const parseJson = (raw: string): unknown => {
  const parsed = Result.try((): unknown => JSON.parse(raw));
  return Result.isOk(parsed) ? parsed.value : undefined;
};

/**
 * The authorization code a dialog message carries for this attempt.
 *
 * The message must come from the task pane's own origin (the callback page)
 * and repeat the attempt's `state`. Its issuer (RFC 9207) must be the one the
 * attempt started with, so a response from another server cannot be redeemed
 * here; a server that promises to name its issuer must do so.
 */
export const readCallbackMessage = ({
  expectedIssuer,
  expectedOrigin,
  expectedState,
  issuerRequired,
  origin,
  raw,
}: {
  readonly expectedIssuer: string;
  readonly expectedOrigin: string;
  readonly expectedState: string;
  /** `authorization_response_iss_parameter_supported` from the metadata. */
  readonly issuerRequired: boolean;
  /** The sender origin Office reports for the dialog message. */
  readonly origin: string | undefined;
  readonly raw: string;
}): Result<string, SignInError> => {
  if (origin !== expectedOrigin) {
    return Result.err(
      new SignInError({
        message: "The sign-in answer came from an unexpected origin",
        failure: "mismatched",
      }),
    );
  }
  const message = v.safeParse(callbackMessageSchema, parseJson(raw));
  if (!message.success) {
    return Result.err(
      new SignInError({
        message: "The sign-in answer is not an authorization response",
        failure: "malformed",
      }),
    );
  }
  const { code, error, iss, state } = message.output;
  if (state !== expectedState) {
    return Result.err(
      new SignInError({
        message: "The sign-in answer belongs to a different attempt",
        failure: "mismatched",
      }),
    );
  }
  if (iss === null ? issuerRequired : iss !== expectedIssuer) {
    return Result.err(
      new SignInError({
        message: "The sign-in answer comes from a different server",
        failure: "mismatched",
      }),
    );
  }
  if (error !== null) {
    return Result.err(
      new SignInError({
        message: `The authorization server refused: ${error}`,
        failure: "denied",
      }),
    );
  }
  if (code === null || code === "") {
    return Result.err(
      new SignInError({
        message: "The sign-in answer carries no authorization code",
        failure: "malformed",
      }),
    );
  }
  return Result.ok(code);
};
