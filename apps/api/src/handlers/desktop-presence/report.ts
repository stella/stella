import { Result } from "better-result";

import {
  desktopPresenceReportResponseSchema,
  desktopPresenceReportSchema,
} from "@stll/api-contract/desktop-presence";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import type { ReadOutcome } from "@/api/lib/errors/read-outcome";

import {
  type FeedFetch,
  feedFetch,
  latestDesktopRelease,
} from "./latest-release";
import { reportDesktopPresence } from "./service";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  body: desktopPresenceReportSchema,
  response: safePublicHandlerResponseSchemasWithStatusText(
    desktopPresenceReportResponseSchema,
  ),
} satisfies PublicHandlerConfig;

type DesktopPresenceReportDependencies = {
  authorizeAccount: typeof authorizeDesktopAccount;
  /** The newest release; the desktop's own feed, read through the cache. */
  latestRelease?: () => Promise<ReadOutcome<string>>;
};

/** The desktop's updater feed, read under this route's permit. */
const readLatestRelease = async (): Promise<ReadOutcome<string>> => {
  const fetchFeed: FeedFetch = feedFetch(grantThirdPartyOutboundPermit());
  return await latestDesktopRelease(fetchFeed);
};

export const createDesktopPresenceReportEndpoint = (
  dependencies?: DesktopPresenceReportDependencies,
) => {
  const authorizeAccount =
    dependencies?.authorizeAccount ?? authorizeDesktopAccount;
  const latestRelease = dependencies?.latestRelease ?? readLatestRelease;
  return createSafeBoundedPublicHandler(
    config,
    async function* ({ request, body }) {
      const { scopedDb, userId, organizationId } = yield* Result.await(
        authorizeAccount(request),
      );
      const [reported, release] = yield* Result.await(
        Result.tryPromise(
          async () =>
            await Promise.all([
              reportDesktopPresence({
                scopedDb,
                userId,
                organizationId,
                report: body,
              }),
              latestRelease(),
            ]),
        ),
      );
      // A feed that could not be read names no release: the desktop keeps
      // its own schedule, which reads the same feed.
      return Result.ok({
        reported,
        latestVersion: release.type === "present" ? release.value : null,
      });
    },
  );
};

export default createDesktopPresenceReportEndpoint();
