import { panic } from "better-result";

import type { RootDatabase } from "@/api/db/root";
import { admitOAuthCredential } from "@/api/lib/auth/oauth-grant-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/** Unit fixtures obtain the real opaque credential from an empty control plane. */
export const admittedOAuthCredentialForTest = async (clientId: string) => {
  const query = {
    from: () => query,
    leftJoin: () => query,
    limit: async () => [],
  };
  const result = await admitOAuthCredential({
    credential: { type: "oauth_client", clientId, issuedAt: 1_700_000_000 },
    organizationId: "organization",
    userId: "user",
    db: asTestRaw<Pick<RootDatabase, "select">>({ select: () => query }),
  });
  return result.isOk() ? result.value : panic(result.error.message);
};
