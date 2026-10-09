import { Result } from "better-result";

import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";

const REQUIRED_FEATURE_IDS = [
  "activity-timeline",
  "time-billing",
] as const satisfies readonly DesktopFeatureId[];

export const authorizeDesktopTimeEntries = async (
  request: Request,
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  await Result.gen(async function* () {
    const account = yield* Result.await(authorizeAccount(request));
    const safeDb = safeDbFromScoped(account.scopedDb);
    const snapshot = yield* Result.await(
      loadFeatureAccessSnapshot({
        safeDb,
        organizationId: account.organizationId,
        userId: account.userId,
      }),
    );
    if (
      REQUIRED_FEATURE_IDS.some(
        (featureId) => !isFeatureEnabled(snapshot, featureId, account),
      )
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Draft time entries are unavailable",
        }),
      );
    }
    return Result.ok({ ...account, safeDb });
  });
