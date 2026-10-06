import { Result } from "better-result";
import { t } from "elysia";

import { desktopPresenceReportSchema } from "@stll/api-contract/desktop-presence";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";

import { reportDesktopPresence } from "./service";

const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  body: desktopPresenceReportSchema,
  response: safePublicHandlerResponseSchemasWithStatusText(
    t.Object({ reported: t.Boolean() }, { additionalProperties: false }),
  ),
} satisfies PublicHandlerConfig;

type DesktopPresenceReportDependencies = {
  authorizeAccount: typeof authorizeDesktopAccount;
};

export const createDesktopPresenceReportEndpoint = (
  dependencies?: DesktopPresenceReportDependencies,
) => {
  const authorizeAccount =
    dependencies?.authorizeAccount ?? authorizeDesktopAccount;
  return createSafeBoundedPublicHandler(
    config,
    async function* ({ request, body }) {
      const { scopedDb, userId, organizationId } = yield* Result.await(
        authorizeAccount(request),
      );
      const reported = yield* Result.await(
        Result.tryPromise(
          async () =>
            await reportDesktopPresence({
              scopedDb,
              userId,
              organizationId,
              report: body,
            }),
        ),
      );
      return Result.ok({ reported });
    },
  );
};

export default createDesktopPresenceReportEndpoint();
