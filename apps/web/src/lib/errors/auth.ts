import { TaggedError } from "better-result";

import { APIError } from "@/lib/errors/api";
import {
  STATUS_ERROR_KEYS,
  STATUS_TO_KEY,
  translateError,
} from "@/lib/errors/localization";

const AUTH_ERROR_CODES = {
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION: true,
} as const;
type AuthErrorCode = keyof typeof AUTH_ERROR_CODES;

export class AuthClientError extends TaggedError("AuthClientError")<{
  code?: AuthErrorCode | undefined;
  message: string;
  status: number;
  statusText: string;
}>() {}

type ToAuthClientErrorProps = {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
  statusText: string;
};

const AUTH_ERROR_KEYS = {
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION:
    "errors.apiCodes.notOrganizationMember",
} as const;

const isAuthClientErrorCode = (code: string): code is AuthErrorCode =>
  Object.hasOwn(AUTH_ERROR_CODES, code);

export const toAuthClientError = (props: ToAuthClientErrorProps) => {
  const { code, status, statusText } = props;
  const message = translateError(
    STATUS_TO_KEY[status] ?? STATUS_ERROR_KEYS.unknown,
  );
  if (!code) {
    return new AuthClientError({ message, status, statusText });
  }
  if (isAuthClientErrorCode(code)) {
    return new AuthClientError({
      code,
      message: translateError(AUTH_ERROR_KEYS[code]),
      status,
      statusText,
    });
  }
  return new APIError({
    code,
    message,
    rawMessage: props.message,
    status,
  });
};

export const isMemberError = (error: Error) =>
  AuthClientError.is(error) &&
  error.code === "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION";

export const isUnauthorizedError = (error: Error) =>
  (APIError.is(error) || AuthClientError.is(error)) && error.status === 401;
