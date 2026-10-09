import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Result } from "better-result";
import { t } from "elysia";

import { TIME_ENTRY_SOURCE } from "@stll/api-contract";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createTimeEntryBodySchema } from "@/api/lib/billing/time-entry-body";
import { createTimeEntryHandler } from "@/api/lib/billing/time-entry-insert";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

import { authorizeDesktopTimeEntries } from "./authorize";

const desktopTimeEntryBodySchema = t.Pick(
  createTimeEntryBodySchema,
  ["dateWorked", "timezoneId", "durationMinutes", "narrative", "billable"],
  { additionalProperties: false },
);

// A parent Elysia app can re-enable normalization for TypeBox schemas. Standard
// Schema validates the original body, so unexpected activity data is rejected.
const strictDesktopTimeEntryBodySchema: StandardSchemaV1<
  unknown,
  Static<typeof desktopTimeEntryBodySchema>
> = {
  "~standard": {
    version: 1,
    vendor: "typebox",
    validate: (input) => {
      if (Value.Check(desktopTimeEntryBodySchema, input)) {
        return { value: input };
      }
      return {
        issues: [...Value.Errors(desktopTimeEntryBodySchema, input)].map(
          ({ message }) => ({ message }),
        ),
      };
    },
  },
};

export const createDesktopTimeEntryEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      params: t.Object({ workspaceId: tSafeId("workspace") }),
      body: strictDesktopTimeEntryBodySchema,
      response: safePublicHandlerResponseSchemasWithStatusText(
        t.Object({ id: t.String() }, { additionalProperties: false }),
      ),
    },
    async function* ({ request, params: { workspaceId }, body }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      if (!hasMemberPermission(account.memberRole, { timeEntry: ["create"] })) {
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Time entry creation is not permitted",
          }),
        );
      }
      const workspace = yield* Result.await(
        account.safeDb((tx) =>
          tx.query.workspaces.findFirst({
            where: {
              id: { eq: workspaceId },
              organizationId: { eq: account.organizationId },
              status: { eq: "active" },
            },
            columns: { id: true },
          }),
        ),
      );
      if (!workspace) {
        return Result.err(
          new HandlerError({ status: 404, message: "Matter not found" }),
        );
      }
      return yield* createTimeEntryHandler({
        safeDb: account.safeDb,
        organizationId: account.organizationId,
        userId: account.userId,
        memberRole: account.memberRole,
        workspaceId,
        body,
        source: TIME_ENTRY_SOURCE.ACTIVITY,
        recordAuditEvent: createAuditRecorder({
          organizationId: account.organizationId,
          userId: account.userId,
          workspaceId,
          request,
          server: null,
        }),
      });
    },
  );

export default createDesktopTimeEntryEndpoint();
