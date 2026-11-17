import { Result } from "better-result";

import { rootDb } from "@/api/db/root";
import {
  featureAccessSnapshotFromAuthorization,
  resolveCredentialMemberAuthorization,
} from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { verifyTimerActivityActionKey } from "@/api/lib/push/timer-activity-devices";

/** Who a Lock Screen button acts for, once its key and membership check out. */
export type TimerActivityActor = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const refused = () =>
  new HandlerError({
    status: 401,
    message: "The timer key is not valid",
    hint: "Open the app to register the phone again.",
  });

/**
 * The person a Lock Screen button key acts for, as they stand now: the key
 * must be live on the phone it was issued to, the person still a member of
 * the organization with a role that may change their time, and time billing
 * open to them there. The key is the request's only credential, so it is
 * looked up on the owner connection; nothing else is read on it.
 */
export const authorizeTimerActivityKey = async ({
  deviceId,
  key,
}: {
  deviceId: string;
  key: string;
}): Promise<Result<TimerActivityActor, HandlerError>> => {
  const actor = await verifyTimerActivityActionKey(rootDb, { deviceId, key });
  if (actor === null) {
    return Result.err(refused());
  }
  const member = await resolveCredentialMemberAuthorization(actor);
  if (member === null || !isMemberRole(member.role)) {
    return Result.err(refused());
  }
  const billing = isFeatureEnabled(
    featureAccessSnapshotFromAuthorization({ ...actor, authorization: member }),
    "time-billing",
    actor,
  );
  if (
    !billing ||
    !hasMemberPermission(sessionMemberRole(member.role), {
      timeEntry: ["update"],
    })
  ) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Timers are unavailable to this account",
      }),
    );
  }
  return Result.ok(actor);
};
