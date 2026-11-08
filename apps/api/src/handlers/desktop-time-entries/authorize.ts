import { Result } from "better-result";

import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";

// The activity timeline requires time billing in the feature registry, so
// this one decision covers both.
const REQUIRED_FEATURE_ID = "activity-timeline" satisfies DesktopFeatureId;

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
