import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { listPersonalApiKeys } from "@/api/lib/personal-api-key-lifecycle";

import { personalApiKeyListQuerySchema } from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: { type: "internal", reason: "provider_secret" },
  query: personalApiKeyListQuerySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ session, user, query }) {
    const page = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          listPersonalApiKeys({
            access: "own",
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
