import { Result } from "better-result";

import { RESOURCE_TYPE } from "@stll/api-contract";

import {
  ACCOUNT_MEMBERSHIP_PAGE_SIZE,
  readAccountMembershipPage,
} from "@/api/lib/db/account-row";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { iterateCursorPages } from "@/api/lib/pagination";
import { broadcastOrganizationResourceSetUpdated } from "@/api/lib/resource-realtime";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

const USER_PROJECTION_NOTIFICATION_FAILED = failureSink({
  event: "auth.user_projection_notification_failed",
  expected: [],
});

type UserProjectionUpdateOptions = {
  readMembershipPage?: typeof readAccountMembershipPage;
  publish?: typeof broadcastOrganizationResourceSetUpdated;
  observe?: typeof observeFailure;
};

/** Better Auth runs this hook after the owning transaction commits. The user
 * row belongs to every actual membership, not only the request's active firm. */
export const createUserProjectionUpdateHook =
  ({
    readMembershipPage = readAccountMembershipPage,
    publish = broadcastOrganizationResourceSetUpdated,
    observe = observeFailure,
  }: UserProjectionUpdateOptions = {}) =>
  async (user: { id: string } | null) => {
    // An adapter update that matches no row has committed no user change.
    if (user === null) {
      return;
    }
    const notified = await Result.tryPromise(async () => {
      const userId = brandPersistedUserId(user.id);
      const pages = iterateCursorPages(async (cursor) => {
        const items = await readMembershipPage({
          userId,
          ...(cursor === null ? {} : { after: cursor }),
        });
        return {
          items,
          nextCursor: items.at(-1)?.id ?? null,
          limit: ACCOUNT_MEMBERSHIP_PAGE_SIZE,
        };
      });
      for await (const memberships of pages) {
        for (const membership of memberships) {
          publish(
            brandPersistedOrganizationId(membership.organizationId),
            RESOURCE_TYPE.USER,
          );
        }
      }
    });
    if (Result.isError(notified)) {
      observe(notified.error, { sink: USER_PROJECTION_NOTIFICATION_FAILED });
    }
  };
