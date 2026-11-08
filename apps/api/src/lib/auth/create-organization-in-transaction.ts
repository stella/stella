import { runWithAdapter } from "@better-auth/core/context";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { OrganizationCreationDependencies } from "@/api/db/root";
import { getAuth } from "@/api/lib/auth";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { withOrganizationCreationTransaction } from "@/api/lib/auth/organization-creation-transaction";
import { withBatchedOrganizationMemberships } from "@/api/lib/auth/organization-membership-adapter";

/** The raw endpoint retains lifecycle hooks while its writes share the caller's transaction. */
export const createOrganizationInTransaction: OrganizationCreationDependencies["createOrganization"] =
  async ({ transaction, body }) => {
    const auth = getAuth();
    const context = await auth.$context;
    const adapter = withBatchedOrganizationMemberships(
      drizzleAdapter(transaction, {
        ...AUTH_DATABASE_ADAPTER_OPTIONS,
        transaction: false,
      })(context.options),
    );
    return await withOrganizationCreationTransaction(
      transaction,
      async () =>
        await runWithAdapter(
          adapter,
          async () =>
            await auth.organizationCreateEndpoint({
              body,
              context: { ...context, adapter },
            }),
        ),
    );
  };
