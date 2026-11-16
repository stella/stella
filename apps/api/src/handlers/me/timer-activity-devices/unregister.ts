import { Result } from "better-result";

import { timerActivityDeviceParamsSchema } from "@stll/api-contract/timer-activity";
import type { TimerActivityDeviceRemovalResponse } from "@stll/api-contract/timer-activity";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { unregisterTimerActivityDevice } from "@/api/lib/push/timer-activity-devices";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Stop updating a phone's Lock Screen timer, as the mobile app does when " +
    "the person signs out. Succeeds with removed: false when the phone was " +
    "not registered, so a retried sign-out never fails.",
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
} satisfies HandlerConfig;

/** `DELETE /v1/me/timer-activity-devices/:deviceId`: only the caller's own row. */
const unregisterTimerActivityDeviceEndpoint = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, user }) {
    const removed = yield* Result.await(
      safeDb(
        async (tx) =>
          await unregisterTimerActivityDevice(tx, {
            deviceId: params.deviceId,
            userId: user.id,
          }),
      ),
    );
    return Result.ok({ removed } satisfies TimerActivityDeviceRemovalResponse);
  },
);

declareAggregateMutation(unregisterTimerActivityDeviceEndpoint, {
  type: "independent",
  reason: "Deletes at most the caller's own phone row by its device id.",
});

export default unregisterTimerActivityDeviceEndpoint;
