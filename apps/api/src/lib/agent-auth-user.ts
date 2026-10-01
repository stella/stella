import { runWithEndpointContext } from "@better-auth/core/context";

type CreateAgentUserOptions = {
  context: Parameters<typeof runWithEndpointContext>[0]["context"];
  email: string;
  name: string;
  emailVerified: boolean;
};

export const createAgentUser = async ({
  context,
  email,
  name,
  emailVerified,
}: CreateAgentUserOptions) =>
  await runWithEndpointContext(
    { context },
    async () =>
      await context.internalAdapter.createUser(
        { email, name, emailVerified },
        { method: "agent-idjag" },
      ),
  );
