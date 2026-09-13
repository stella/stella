import { Temporal } from "@stll/time";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors/auth";

export const getFreshLinkedAccount = async () => {
  const result = await authClient.getSession();

  if (result.error) {
    throw toAuthClientError(result.error);
  }

  if (!result.data) {
    return null;
  }

  const { user, session } = result.data;
  if (user.email.length === 0) {
    return null;
  }

  return {
    identity: {
      userId: user.id,
      organizationId: session.activeOrganizationId,
    },
    email: user.email,
    name: user.name,
    verifiedAt: Temporal.Now.instant().toString({ fractionalSecondDigits: 3 }),
  };
};
