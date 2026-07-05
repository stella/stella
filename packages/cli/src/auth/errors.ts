// Tagged errors for the `stella auth` flow (see AGENTS.md "Error Handling":
// tagged errors over bare `Error`, one `message: string` field on every one).
//
// Hand-rolled rather than `better-result`'s `TaggedError(tag)<Props>()`
// factory: that factory's `class Foo extends TaggedError("Foo")<Props>() {}`
// shape requires a call expression in the `extends` clause, which
// `isolatedDeclarations` (this package builds with it — see
// `cli-config.ts`) rejects outright (`TS9021`). `CliBaseError<Tag>` below
// gives the same discriminated-union/`_tag` shape without a factory call.
// Every subclass also declares its own literal `name` field (oxlint's
// `unicorn/custom-error-definition` checks each class individually, not
// through inheritance).

export class CliBaseError<Tag extends string> extends Error {
  override readonly name: Tag;
  readonly _tag: Tag;

  constructor(tag: Tag, message: string) {
    super(message);
    // eslint-disable-next-line unicorn/custom-error-definition -- generic base, never instantiated directly; every concrete subclass sets its own literal `name` too
    this.name = tag;
    this._tag = tag;
  }
}

export class OAuthMetadataError extends CliBaseError<"OAuthMetadataError"> {
  override readonly name = "OAuthMetadataError";
  readonly serverUrl: string;
  override readonly cause?: unknown;

  constructor(props: { message: string; serverUrl: string; cause?: unknown }) {
    super("OAuthMetadataError", props.message);
    this.serverUrl = props.serverUrl;
    this.cause = props.cause;
  }
}

export class ClientRegistrationError extends CliBaseError<"ClientRegistrationError"> {
  override readonly name = "ClientRegistrationError";
  override readonly cause?: unknown;

  constructor(props: { message: string; cause?: unknown }) {
    super("ClientRegistrationError", props.message);
    this.cause = props.cause;
  }
}

export class TokenExchangeError extends CliBaseError<"TokenExchangeError"> {
  override readonly name = "TokenExchangeError";
  readonly oauthError?: string | undefined;
  override readonly cause?: unknown;

  constructor(props: {
    message: string;
    oauthError?: string | undefined;
    cause?: unknown;
  }) {
    super("TokenExchangeError", props.message);
    this.oauthError = props.oauthError;
    this.cause = props.cause;
  }
}

export class TokenRefreshError extends CliBaseError<"TokenRefreshError"> {
  override readonly name = "TokenRefreshError";
  readonly oauthError?: string | undefined;
  override readonly cause?: unknown;

  constructor(props: {
    message: string;
    oauthError?: string | undefined;
    cause?: unknown;
  }) {
    super("TokenRefreshError", props.message);
    this.oauthError = props.oauthError;
    this.cause = props.cause;
  }
}

export class LoopbackTimeoutError extends CliBaseError<"LoopbackTimeoutError"> {
  override readonly name = "LoopbackTimeoutError";

  constructor(props: { message: string }) {
    super("LoopbackTimeoutError", props.message);
  }
}

export class LoopbackCallbackError extends CliBaseError<"LoopbackCallbackError"> {
  override readonly name = "LoopbackCallbackError";
  readonly oauthError: string;
  readonly oauthErrorDescription?: string | undefined;

  constructor(props: {
    message: string;
    oauthError: string;
    oauthErrorDescription?: string | undefined;
  }) {
    super("LoopbackCallbackError", props.message);
    this.oauthError = props.oauthError;
    this.oauthErrorDescription = props.oauthErrorDescription;
  }
}

export class ManualCallbackParseError extends CliBaseError<"ManualCallbackParseError"> {
  override readonly name = "ManualCallbackParseError";

  constructor(props: { message: string }) {
    super("ManualCallbackParseError", props.message);
  }
}

export class ServerUrlNotConfiguredError extends CliBaseError<"ServerUrlNotConfiguredError"> {
  override readonly name = "ServerUrlNotConfiguredError";

  constructor(props: { message: string }) {
    super("ServerUrlNotConfiguredError", props.message);
  }
}

export class CredentialNotFoundError extends CliBaseError<"CredentialNotFoundError"> {
  override readonly name = "CredentialNotFoundError";
  readonly serverUrl: string;
  readonly org?: string | undefined;

  constructor(props: {
    message: string;
    serverUrl: string;
    org?: string | undefined;
  }) {
    super("CredentialNotFoundError", props.message);
    this.serverUrl = props.serverUrl;
    this.org = props.org;
  }
}

export class MissingOrgClaimError extends CliBaseError<"MissingOrgClaimError"> {
  override readonly name = "MissingOrgClaimError";
  readonly serverUrl: string;

  constructor(props: { message: string; serverUrl: string }) {
    super("MissingOrgClaimError", props.message);
    this.serverUrl = props.serverUrl;
  }
}

export class NoRefreshTokenError extends CliBaseError<"NoRefreshTokenError"> {
  override readonly name = "NoRefreshTokenError";

  constructor(props: { message: string }) {
    super("NoRefreshTokenError", props.message);
  }
}

export type CliAuthError =
  | OAuthMetadataError
  | ClientRegistrationError
  | TokenExchangeError
  | TokenRefreshError
  | LoopbackTimeoutError
  | LoopbackCallbackError
  | ManualCallbackParseError
  | ServerUrlNotConfiguredError
  | CredentialNotFoundError
  | MissingOrgClaimError
  | NoRefreshTokenError;
