import { Result } from "better-result";
import * as v from "valibot";

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
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  body: desktopPresenceReportSchema,
  response: safePublicHandlerResponseSchemasWithStatusText(
    v.object({ reported: v.boolean() }),
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
