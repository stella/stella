import { authClient } from "@/lib/auth";
import { ClientUnknownError, toAuthClientError } from "@/lib/errors";

type AuthSessionError = {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
  statusText: string;
};

type AuthSessionResult = {
  data?: {
    session?: {
      token?: string | null;
    } | null;
    user?: {
      email: string;
      name?: string | null;
    } | null;
  } | null;
  error?: AuthSessionError | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isAuthSessionError = (value: unknown): value is AuthSessionError =>
  isRecord(value) &&
  typeof value.status === "number" &&
  typeof value.statusText === "string" &&
  ("code" in value ? typeof value.code === "string" : true) &&
  ("message" in value ? typeof value.message === "string" : true);

const isAuthSessionResult = (value: unknown): value is AuthSessionResult => {
  if (!isRecord(value)) {
    return false;
  }

  const dataValid =
    !("data" in value) ||
    value.data === null ||
    (isRecord(value.data) &&
      (!("session" in value.data) ||
        value.data.session === null ||
        (isRecord(value.data.session) &&
          (!("token" in value.data.session) ||
            value.data.session.token === null ||
            typeof value.data.session.token === "string"))) &&
      (!("user" in value.data) ||
        value.data.user === null ||
        (isRecord(value.data.user) &&
          typeof value.data.user.email === "string" &&
          (!("name" in value.data.user) ||
            value.data.user.name === null ||
            typeof value.data.user.name === "string"))));

  const errorValid =
    !("error" in value) ||
    value.error === null ||
    isAuthSessionError(value.error);

  return dataValid && errorValid;
};

export const getFreshAuthToken = async () => {
  // SAFETY: Better Auth returns a `{ data, error }` envelope at runtime,
  // but the current client typing is too loose for strict type-aware linting.
  // Narrow it immediately with a structural guard before reading fields.
  // eslint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
  const result: unknown = await authClient.getSession();

  if (!isAuthSessionResult(result)) {
    throw new ClientUnknownError({
      message: "Unexpected auth session response.",
    });
  }

  if (result.error) {
    throw toAuthClientError(result.error);
  }

  const token = result.data?.session?.token;
  return typeof token === "string" && token.length > 0 ? token : null;
};

export const getFreshLinkedAccount = async () => {
  // SAFETY: Better Auth returns a `{ data, error }` envelope at runtime,
  // but the current client typing is too loose for strict type-aware linting.
  // Narrow it immediately with a structural guard before reading fields.
  // eslint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
  const result: unknown = await authClient.getSession();

  if (!isAuthSessionResult(result)) {
    throw new ClientUnknownError({
      message: "Unexpected auth session response.",
    });
  }

  if (result.error) {
    throw toAuthClientError(result.error);
  }

  const user = result.data?.user;
  if (!user || user.email.length === 0) {
    return null;
  }

  return {
    email: user.email,
    name: user.name ?? null,
    verifiedAt: new Date().toISOString(),
  };
};
