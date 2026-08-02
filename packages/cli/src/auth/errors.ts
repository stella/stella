import { TaggedError, type TaggedErrorClass } from "better-result";

const OAuthMetadataErrorBase: TaggedErrorClass<"OAuthMetadataError"> =
  TaggedError("OAuthMetadataError");

export class OAuthMetadataError extends OAuthMetadataErrorBase<{
  message: string;
  serverUrl: string;
  cause?: unknown;
}> {}

const ClientRegistrationErrorBase: TaggedErrorClass<"ClientRegistrationError"> =
  TaggedError("ClientRegistrationError");

export class ClientRegistrationError extends ClientRegistrationErrorBase<{
  message: string;
  cause?: unknown;
}> {}

const TokenExchangeErrorBase: TaggedErrorClass<"TokenExchangeError"> =
  TaggedError("TokenExchangeError");

export class TokenExchangeError extends TokenExchangeErrorBase<{
  message: string;
  oauthError?: string | undefined;
  cause?: unknown;
}> {}

const TokenRefreshErrorBase: TaggedErrorClass<"TokenRefreshError"> =
  TaggedError("TokenRefreshError");

export class TokenRefreshError extends TokenRefreshErrorBase<{
  message: string;
  oauthError?: string | undefined;
  cause?: unknown;
}> {}

const LoopbackTimeoutErrorBase: TaggedErrorClass<"LoopbackTimeoutError"> =
  TaggedError("LoopbackTimeoutError");

export class LoopbackTimeoutError extends LoopbackTimeoutErrorBase<{
  message: string;
}> {}

const LoopbackCallbackErrorBase: TaggedErrorClass<"LoopbackCallbackError"> =
  TaggedError("LoopbackCallbackError");

export class LoopbackCallbackError extends LoopbackCallbackErrorBase<{
  message: string;
  oauthError: string;
  oauthErrorDescription?: string | undefined;
}> {}

const ManualCallbackParseErrorBase: TaggedErrorClass<"ManualCallbackParseError"> =
  TaggedError("ManualCallbackParseError");

export class ManualCallbackParseError extends ManualCallbackParseErrorBase<{
  message: string;
}> {}

const ServerUrlNotConfiguredErrorBase: TaggedErrorClass<"ServerUrlNotConfiguredError"> =
  TaggedError("ServerUrlNotConfiguredError");

export class ServerUrlNotConfiguredError extends ServerUrlNotConfiguredErrorBase<{
  message: string;
}> {}

const CredentialNotFoundErrorBase: TaggedErrorClass<"CredentialNotFoundError"> =
  TaggedError("CredentialNotFoundError");

export class CredentialNotFoundError extends CredentialNotFoundErrorBase<{
  message: string;
  serverUrl: string;
  org?: string | undefined;
}> {}

const MissingOrgClaimErrorBase: TaggedErrorClass<"MissingOrgClaimError"> =
  TaggedError("MissingOrgClaimError");

export class MissingOrgClaimError extends MissingOrgClaimErrorBase<{
  message: string;
  serverUrl: string;
}> {}

const UnsupportedOAuthScopesErrorBase: TaggedErrorClass<"UnsupportedOAuthScopesError"> =
  TaggedError("UnsupportedOAuthScopesError");

export class UnsupportedOAuthScopesError extends UnsupportedOAuthScopesErrorBase<{
  message: string;
  missingScopes: readonly string[];
}> {}

const NoRefreshTokenErrorBase: TaggedErrorClass<"NoRefreshTokenError"> =
  TaggedError("NoRefreshTokenError");

export class NoRefreshTokenError extends NoRefreshTokenErrorBase<{
  message: string;
}> {}

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
  | UnsupportedOAuthScopesError
  | NoRefreshTokenError;
