import { createAuthEndpoint } from "@better-auth/core/api";
import type { BetterAuthPlugin } from "better-auth";
import * as v from "valibot";

export const createAgentUserPlugin = () =>
  ({
    id: "agent-identity-provisioning",
    endpoints: {
      createAgentUser: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: v.object({
            email: v.pipe(v.string(), v.email()),
            name: v.string(),
            emailVerified: v.boolean(),
          }),
        },
        async ({ body, context }) =>
          await context.internalAdapter.createUser(body, {
            method: "agent-idjag",
          }),
      ),
    },
  }) satisfies BetterAuthPlugin;
