import { Type } from "@sinclair/typebox";
import { Result } from "better-result";
import { t } from "elysia";

import { desktopMattersResponseSchema } from "@stll/api-contract/desktop-time-entries";
import type { DesktopMattersResponse } from "@stll/api-contract/desktop-time-entries";

import { readWorkspaceListRows } from "@/api/handlers/workspaces/list-query";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { jsonSchemaToTypeBox } from "@/api/lib/json-schema/json-schema-to-typebox";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";

import { authorizeDesktopTimeEntries } from "./authorize";

const mattersResponseSchema = Type.Unsafe<DesktopMattersResponse>(
  jsonSchemaToTypeBox(toJsonSchema(desktopMattersResponseSchema)),
);

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
        mattersResponseSchema,
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
        matters: rows.map(({ id, name, reference, color }) => ({
          id,
          name,
          reference,
          color,
        })),
      });
    },
  );

export default createDesktopMattersEndpoint();
