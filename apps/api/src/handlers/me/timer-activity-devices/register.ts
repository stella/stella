import { Result } from "better-result";

import {
  timerActivityDeviceParamsSchema,
  timerActivityDeviceRegistrationSchema,
} from "@stll/api-contract/timer-activity";
import type { TimerActivityDeviceRegistrationResponse } from "@stll/api-contract/timer-activity";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { registerTimerActivityDevice } from "@/api/lib/push/timer-activity-devices";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Register the phone the stella mobile app runs on for its Lock Screen " +
    "timer, or replace its registration: the tokens that start and update " +
    "the timer's Live Activity, and whether updates may name the timer's " +
    "description and matter. Idempotent per device id.",
  // permissions-exempt: the write touches only the caller's own phone rows
  // (user-scoped RLS); workspace:read is the access floor every member has.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "native_device" },
  realtime: noResourceSetUpdates(
    "A phone registration belongs only to the caller and appears in no shared view.",
  ),
  access: "write",
  params: timerActivityDeviceParamsSchema,
  body: timerActivityDeviceRegistrationSchema,
} satisfies HandlerConfig;

/**
 * `PUT /v1/me/timer-activity-devices/:deviceId`. The phone is filed under
 * the caller and the organization their session is in; neither comes from
 * the body. Nothing is sent back: the app has just drawn its own Lock Screen,
 * and the next timer change made elsewhere reaches it with this state.
 */
const registerTimerActivityDeviceEndpoint = createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, user }) {
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    yield* Result.await(
      safeDb(
        async (tx) =>
          await registerTimerActivityDevice(tx, {
            ...owner,
            deviceId: params.deviceId,
            registration: body,
          }),
      ),
    );
    return Result.ok({
      registered: true,
    } satisfies TimerActivityDeviceRegistrationResponse);
  },
);

declareAggregateMutation(registerTimerActivityDeviceEndpoint, {
  type: "independent",
  reason:
    "Upserts the caller's own phone row by its device id and trims the caller's oldest phones; no aggregate spans other rows.",
});

export default registerTimerActivityDeviceEndpoint;
