import { Result } from "better-result";
import * as v from "valibot";

import {
  TIMER_ACTIVITY_ACTIONS,
  timerActivityDeviceParamsSchema,
} from "@stll/api-contract/timer-activity";

import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig, VerifyCaller } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { timerStateTransition } from "@/api/lib/billing/time-timers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { authorizeTimerActivityKey } from "@/api/lib/push/timer-activity-actions";
import type { TimerActivityActor } from "@/api/lib/push/timer-activity-actions";
import { createRootMembershipSafeDb } from "@/api/lib/root-scoped-db";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "native_device" },
  params: timerActivityDeviceParamsSchema,
  body: v.strictObject({
    timerId: resourceIdSchema("timeTimer"),
    action: v.picklist(TIMER_ACTIVITY_ACTIONS),
  }),
} satisfies TokenHandlerConfig;

const BEARER_PREFIX = "Bearer ";

/**
 * The key a Lock Screen button sends, checked against the phone it was
 * issued to, and the person's membership as it stands now, before anything
 * else is read from the request.
 */
const verifyTimerKey: VerifyCaller<TimerActivityActor> = async ({
  request,
  params,
}) => {
  const authorization = request.headers.get("authorization") ?? "";
  const device = v.safeParse(timerActivityDeviceParamsSchema, params);
  if (!authorization.startsWith(BEARER_PREFIX) || !device.success) {
    return Result.err(
      new HandlerError({ status: 401, message: "The timer key is not valid" }),
    );
  }
  return await authorizeTimerActivityKey({
    deviceId: device.output.deviceId,
    key: authorization.slice(BEARER_PREFIX.length),
  });
};

/**
 * `POST /v1/me/timer-activity-devices/:deviceId/actions`: a Lock Screen
 * button pausing or resuming the person's own timer, sent by the phone's
 * native side without a session. The change is the one the timer's own
 * pause and resume make, on the person's own membership-scoped connection,
 * audited as theirs.
 */
const actOnTimer = createSafeTokenHandler(
  config,
  verifyTimerKey,
  async function* ({ body, caller, request }) {
    return yield* timerStateTransition(
      body.action === "pause" ? "paused" : "running",
    )({
      safeDb: createRootMembershipSafeDb(caller),
      session: { activeOrganizationId: caller.organizationId },
      user: { id: caller.userId },
      params: { id: body.timerId },
      recordAuditEvent: createAuditRecorder({
        organizationId: caller.organizationId,
        userId: caller.userId,
        workspaceId: null,
        request,
        server: null,
      }),
    });
  },
);

declareAggregateMutation(actOnTimer, {
  type: "independent",
  reason:
    "Pauses or resumes one of the key holder's own timers under their timer owner lock, as the timer routes do; no aggregate spans other rows.",
});

export default actOnTimer;
