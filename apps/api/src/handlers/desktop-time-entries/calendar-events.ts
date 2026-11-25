import { Result } from "better-result";

import {
  desktopCalendarEventsQuerySchema,
  type DesktopCalendarEventsResponse,
  desktopCalendarEventsResponseSchema,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { listDayReviewEvents } from "@/api/lib/auth/microsoft365/calendar-client";
import { readCalendarConnection } from "@/api/lib/auth/microsoft365/calendar-connection";
import { ensureSharepointAccessToken } from "@/api/lib/auth/microsoft365/graph-token";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { authorizeDesktopTimeEntries } from "./authorize";

const CALENDAR_EVENTS_DEPENDENCIES = {
  authorizeAccount: authorizeDesktopAccount,
  deploymentEnabled: isDeploymentFeatureEnabled,
  listDayReviewEvents,
  ensureAccessToken: ensureSharepointAccessToken,
};

const answered = (response: DesktopCalendarEventsResponse) =>
  Result.ok(response);

/**
 * The member's own Microsoft 365 events for one local day of the Activity
 * review, read on request and never stored. Only the minimised fields leave
 * the server; the desktop shows them as evidence and counts none of them.
 */
export const createDesktopCalendarEventsEndpoint = (
  dependencies = CALENDAR_EVENTS_DEPENDENCIES,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      query: desktopCalendarEventsQuerySchema,
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopCalendarEventsResponseSchema,
      ),
    },
    async function* ({ request, query: { date, timeZone } }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, dependencies.authorizeAccount),
      );
      const connection = yield* Result.await(
        readCalendarConnection(account, dependencies.deploymentEnabled),
      );
      if (connection.type !== "connected") {
        return answered({ status: connection.type });
      }
      const permit = grantThirdPartyOutboundPermit();
      const token = await dependencies.ensureAccessToken({
        connection: connection.connection,
        safeDb: account.safeDb,
        recordAuditEvent: createAuditRecorder({
          organizationId: account.organizationId,
          userId: account.userId,
          workspaceId: null,
          request,
          server: null,
        }),
        capability: "calendar.read",
        permit,
        signal: request.signal,
      });
      if (Result.isError(token)) {
        // The token owner answers 409 once Microsoft refuses the refresh.
        if (HandlerError.is(token.error) && token.error.status === 409) {
          return answered({ status: "needsReconnect" });
        }
        return Result.err(token.error);
      }
      const day = Temporal.PlainDate.from(date);
      const start = day.toZonedDateTime({ timeZone });
      const end = day.add({ days: 1 }).toZonedDateTime({ timeZone });
      const read = await dependencies.listDayReviewEvents(
        {
          start: start.toInstant().toString(),
          end: end.toInstant().toString(),
        },
        { accessToken: token.value, permit, signal: request.signal },
      );
      if (Result.isError(read)) {
        if (
          read.error.kind === "needs_reconnect" ||
          read.error.kind === "capability_missing"
        ) {
          return answered({ status: "needsReconnect" });
        }
        return Result.err(
          new HandlerError({
            status: 502,
            code: "upstream_unavailable",
            message: "Calendar service unavailable",
            cause: read.error,
          }),
        );
      }
      return answered({ status: "ready", ...read.value });
    },
  );

export default createDesktopCalendarEventsEndpoint();
