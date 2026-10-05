import { Result } from "better-result";

import { desktopPresenceReportSchema } from "@stll/api-contract/desktop-presence";

import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";

import { reportDesktopPresence } from "./service";

const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  body: desktopPresenceReportSchema,
} satisfies PublicHandlerConfig;

type DesktopPresenceReportDependencies = {
  authorizeAccount: typeof authorizeDesktopAccount;
};

export const createDesktopPresenceReportEndpoint = (
  dependencies?: DesktopPresenceReportDependencies,
) => {
  const authorizeAccount =
    dependencies?.authorizeAccount ?? authorizeDesktopAccount;
  return createSafePublicHandler(config, async function* ({ request, body }) {
    const { scopedDb, userId, organizationId } = yield* Result.await(
      authorizeAccount(request),
    );
    yield* Result.await(
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
    return Result.ok({ reported: true });
  });
};

export default createDesktopPresenceReportEndpoint();
