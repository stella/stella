import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";

export const getFreshLinkedAccount = async () => {
  const result = await authClient.getSession();

  if (result.error) {
    throw toAuthClientError(result.error);
  }

  if (!result.data) {
    return null;
  }

  const { user } = result.data;
  if (user.email.length === 0) {
    return null;
  }

  return {
    email: user.email,
    name: user.name,
    verifiedAt: new Date().toISOString(),
  };
};
