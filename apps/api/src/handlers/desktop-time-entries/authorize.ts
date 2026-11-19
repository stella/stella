import { Result } from "better-result";

import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";

// The activity timeline requires time billing in the feature registry, so
// this one decision covers both.
const REQUIRED_FEATURE_ID = "activity-timeline" satisfies DesktopFeatureId;

// A recording transcribed on the desktop is filed under a matter, which the
// member finds by the same search.
const DICTATION_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;

/**
 * The linked desktop account and whether draft time entries are available
 * to it. Only a step every caller may always take, such as withdrawing a
 * consent, uses this without refusing an unavailable feature.
 */
export const authorizeDesktopCaller = async (
  request: Request,
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  await Result.gen(async function* () {
    const account = yield* Result.await(authorizeAccount(request));
    return Result.ok({
      ...account,
      safeDb: safeDbFromScoped(account.scopedDb),
      timeEntriesAvailable: isFeatureEnabled(
        account.featureAccessSnapshot,
        REQUIRED_FEATURE_ID,
        account,
      ),
    });
  });

export const authorizeDesktopTimeEntries = async (
  request: Request,
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  await Result.gen(async function* () {
    const { timeEntriesAvailable, ...account } = yield* Result.await(
      authorizeDesktopCaller(request, authorizeAccount),
    );
    if (!timeEntriesAvailable) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Draft time entries are unavailable",
        }),
      );
    }
    return Result.ok(account);
  });

/**
 * The linked desktop account, when it may look up matters: for draft time
 * entries or to file a transcribed recording. The search reads only the
 * matters the member's own access shows.
 */
export const authorizeDesktopMatterSearch = async (
  request: Request,
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  await Result.gen(async function* () {
    const { timeEntriesAvailable, ...account } = yield* Result.await(
      authorizeDesktopCaller(request, authorizeAccount),
    );
    if (
      !timeEntriesAvailable &&
      !isFeatureEnabled(
        account.featureAccessSnapshot,
        DICTATION_FEATURE_ID,
        account,
      )
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Matter search is unavailable",
        }),
      );
    }
    return Result.ok(account);
  });
