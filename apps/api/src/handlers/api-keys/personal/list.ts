import { Result } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { listPersonalApiKeys } from "@/api/lib/machine-api-keys/personal-lifecycle";

import { personalApiKeyListQuerySchema } from "./schema";

const listPermissions = {
  own: { workspace: ["read"] },
  organization: { organizationSettings: ["update"] },
} satisfies Record<
  Parameters<typeof listPersonalApiKeys>[0]["access"],
  PermissionInput
>;

export const createListPersonalApiKeysHandler = (
  access: keyof typeof listPermissions,
) => {
  const config = {
    access: "read",
    permissions: listPermissions[access],
    accountAccess: ACCOUNT_ACCESS.standard,
    mcp: { type: "internal", reason: "provider_secret" },
    query: personalApiKeyListQuerySchema,
  } satisfies HandlerConfig;

  return createSafeRootHandler(
    config,
    async function* ({ session, user, query }) {
      const page = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            listPersonalApiKeys({
              access,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              limit: query.limit ?? 20,
              cursor: query.cursor,
            }),
          catch: (error: unknown) =>
            HandlerError.is(error)
              ? error
              : new HandlerError({
                  status: 500,
                  message: "Could not list personal API keys",
                  cause: error,
                }),
        }),
      );
      return Result.ok(page);
    },
  );
};

export default createListPersonalApiKeysHandler("own");
