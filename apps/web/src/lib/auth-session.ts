import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";

export const getFreshAuthToken = async () => {
  const result = await authClient.getSession();

  if (result.error) {
    throw toAuthClientError(result.error);
  }

  const token = result.data.session.token;
  return token.length > 0 ? token : null;
};

export const getFreshLinkedAccount = async () => {
  const result = await authClient.getSession();

  if (result.error) {
    throw toAuthClientError(result.error);
  }

  const { user } = result.data;
  if (user.email.length === 0) {
    return null;
  }

  return {
    email: user.email,
    name: user.name ?? null,
    verifiedAt: new Date().toISOString(),
  };
};
