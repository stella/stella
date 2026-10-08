import { Result } from "better-result";
import { t } from "elysia";

import { readWorkspaceListRows } from "@/api/handlers/workspaces/list-query";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";

import { authorizeDesktopTimeEntries } from "./authorize";

export const createDesktopMattersEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      query: t.Object(
        { query: t.Optional(t.String({ maxLength: 200 })) },
        { additionalProperties: false },
      ),
      response: safePublicHandlerResponseSchemasWithStatusText(
        t.Object(
          {
            matters: t.Array(
              t.Object(
                {
                  id: t.String(),
                  name: t.String(),
                  reference: t.Nullable(t.String()),
                },
                { additionalProperties: false },
              ),
              { maxItems: 20 },
            ),
          },
          { additionalProperties: false },
        ),
      ),
    },
    async function* ({ request, query }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      const rows = yield* Result.await(
        account.safeDb((tx) =>
          readWorkspaceListRows({
            tx,
            organizationId: account.organizationId,
            query: query.query,
            limit: 20,
          }),
        ),
      );
      return Result.ok({
        matters: rows.map(({ id, name, reference }) => ({
          id,
          name,
          reference,
        })),
      });
    },
  );

export default createDesktopMattersEndpoint();
