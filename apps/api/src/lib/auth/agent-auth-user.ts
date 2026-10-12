import { createAuthEndpoint } from "@better-auth/core/api";
import type { BetterAuthPlugin } from "better-auth";
import * as v from "valibot";

/** Server-only: the one way an agent's verified identity becomes an account. */
export const AGENT_IDENTITY_CREATE_USER_PATH = "/agent-identity/create-user";

export const createAgentUserPlugin = () =>
  ({
    id: "agent-identity-provisioning",
    endpoints: {
      // A path, so the user hook can recognise this creation, and
      // SERVER_ONLY, so the HTTP router never registers it.
      createAgentUser: createAuthEndpoint(
        AGENT_IDENTITY_CREATE_USER_PATH,
        {
          method: "POST",
          body: v.object({
            email: v.pipe(v.string(), v.email()),
            name: v.string(),
            emailVerified: v.boolean(),
          }),
          metadata: { SERVER_ONLY: true },
        },
        async ({ body, context }) =>
          await context.internalAdapter.createUser(body, {
            method: "agent-idjag",
          }),
      ),
    },
  }) satisfies BetterAuthPlugin;
