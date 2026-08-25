import { rootDb } from "@/api/db/root";
import { ensureBetterAuthOAuthPolicy } from "@/api/lib/db/better-auth-oauth-policy-census";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";

export const assertConfiguredBetterAuthOAuthPolicy =
  async (): Promise<void> => {
    await ensureBetterAuthOAuthPolicy(rootDb, getBetterAuthOAuthResources());
  };
