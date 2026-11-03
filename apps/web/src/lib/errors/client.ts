import { TaggedError } from "better-result";

export const USER_SAFE_CLIENT_OPERATIONS = {
  uploadVersion: "upload-version",
} as const;

type UserSafeClientOperation =
  (typeof USER_SAFE_CLIENT_OPERATIONS)[keyof typeof USER_SAFE_CLIENT_OPERATIONS];

const USER_SAFE_CLIENT_OPERATION_SET: ReadonlySet<UserSafeClientOperation> =
  new Set<UserSafeClientOperation>(Object.values(USER_SAFE_CLIENT_OPERATIONS));

export const isUserSafeClientOperation = (
  action: string,
): action is UserSafeClientOperation =>
  [...USER_SAFE_CLIENT_OPERATION_SET].some(
    (userSafeAction) => userSafeAction === action,
  );

export class ClientOperationError extends TaggedError("ClientOperationError")<{
  action: string;
  message: string;
  cause?: unknown;
}> {}

export class ClientUnknownError extends TaggedError("ClientUnknownError")<{
  message: string;
}> {}

export const transformUnknownError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (error === undefined || error === null) {
    return new ClientUnknownError({
      message: "Unknown error (null or undefined)",
    });
  }

  if (typeof error === "object") {
    return new ClientUnknownError({
      message: JSON.stringify(error),
    });
  }

  return new ClientUnknownError({
    message: typeof error === "string" ? error : JSON.stringify(error),
  });
};
