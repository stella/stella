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

import { authorizeDesktopTimeEntries } from "./authorize";

export const createDesktopTimeEntryEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      params: t.Object({ workspaceId: tSafeId("workspace") }),
      body: t.Pick(
        createTimeEntryBodySchema,
        [
          "dateWorked",
          "timezoneId",
          "durationMinutes",
          "narrative",
          "billable",
        ],
        { additionalProperties: false },
      ),
      response: safePublicHandlerResponseSchemasWithStatusText(
        t.Object({ id: t.String() }, { additionalProperties: false }),
      ),
    },
    async function* ({ request, params: { workspaceId }, body }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
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
