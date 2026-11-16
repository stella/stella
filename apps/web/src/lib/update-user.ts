import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import { authClient } from "@/lib/auth-client";
import { APIError } from "@/lib/errors/api";
import { AuthClientError, toAuthClientError } from "@/lib/errors/auth";
import { resourceMutation } from "@/lib/workspace-realtime";

type UserProjectionOwner = {
  userId: string;
  organizationId: string | null;
} | null;
type CreateUserUpdateMutationOptions<TVariables> = {
  queryClient: QueryClient;
  input: (variables: TVariables) => Parameters<typeof authClient.updateUser>[0];
  owner: UserProjectionOwner;
};

/** The caller binds the authenticated identity, or explicitly has no matter
 * projection during an auth transition. Cached sessions can lag those flows. */
export const createUserUpdateMutation = <TVariables = void>({
  queryClient,
  input,
  owner,
}: CreateUserUpdateMutationOptions<TVariables>) =>
  resourceMutation({
    mutation: "updateUser",
    queryClient,
    scope: {
      type: "organization-projection",
      organizationId: owner?.organizationId ?? null,
      userId: owner?.userId ?? null,
    },
    mutationFn: async (variables: TVariables) => {
      const response = await authClient.updateUser(input(variables));
      if (response.error) {
        throw toAuthClientError(response.error);
      }
      return response.data;
    },
  });

type UpdateUserResourceOptions = {
  queryClient: QueryClient;
  input: Parameters<typeof authClient.updateUser>[0];
  owner: UserProjectionOwner;
};

/** Non-mutation consumers handle an auth refusal as data; transport failures
 * retain their original rejected-promise behavior. */
export const updateUserResource = async ({
  queryClient,
  input,
  owner,
}: UpdateUserResourceOptions) =>
  await createUserUpdateMutation({
    queryClient,
    input: () => input,
    owner,
  })().then(Result.ok, (error: unknown) => {
    if (AuthClientError.is(error) || APIError.is(error)) {
      return Result.err(error);
    }
    throw error;
  });
