import { Result } from "better-result";
import * as v from "valibot";

import { desktopMattersResponseSchema } from "@stll/api-contract/desktop-time-entries";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { readWorkspaceListRows } from "@/api/lib/workspaces/list-query";

import { authorizeDesktopTimeEntries } from "./authorize";

export const createDesktopMattersEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      query: v.strictObject({
        query: v.optional(v.pipe(v.string(), v.maxLength(200))),
      }),
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopMattersResponseSchema,
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
            ...(query.query === undefined ? {} : { query: query.query }),
            limit: 20,
          }),
        ),
      );
      return Result.ok({
        matters: rows.map(({ id, name, reference, color }) => ({
          id: String(id),
          name,
          reference: reference || null,
          color,
        })),
      });
    },
  );

export default createDesktopMattersEndpoint();
