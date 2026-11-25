import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  DESKTOP_ACTIVITY_REVIEW_LIMIT,
  desktopMatterCandidatesResponseSchema,
} from "@stll/api-contract/desktop-time-entries";
import { WORKSPACE_STATUS } from "@stll/api-contract/workspace-status";

import { workspaces } from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { readTimePolicy } from "@/api/lib/billing-time";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { readCursorPage } from "@/api/lib/db/read-bounded";

import { authorizeDesktopTimeEntries } from "./authorize";
import {
  matterCandidateRanking,
  matterCandidateSignals,
  selectMatterCandidates,
  toMatterCandidate,
} from "./matter-candidate-projection";

export const createDesktopMatterCandidatesEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopMatterCandidatesResponseSchema,
      ),
    },
    async function* ({ request }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      const signals = matterCandidateSignals(account.userId);
      const page = yield* Result.await(
        account.safeDb(async (tx) =>
          readCursorPage(
            selectMatterCandidates(tx, signals)
              .where(
                and(
                  eq(workspaces.organizationId, account.organizationId),
                  eq(workspaces.status, WORKSPACE_STATUS.active),
                ),
              )
              .orderBy(...matterCandidateRanking(signals)),
            {
              limit: DESKTOP_ACTIVITY_REVIEW_LIMIT,
              cursorForItem: ({ id }) => String(id),
            },
          ),
        ),
      );
      const policy = yield* Result.await(
        readTimePolicy({
          safeDb: account.safeDb,
          organizationId: account.organizationId,
        }),
      );
      return Result.ok({
        // Matching uses the ranked first page as a shortlist of likely matters.
        matters: page.items.map(toMatterCandidate),
        timeMinimumUnitMinutes: policy.timeMinimumUnitMinutes,
      });
    },
  );
export default createDesktopMatterCandidatesEndpoint();
