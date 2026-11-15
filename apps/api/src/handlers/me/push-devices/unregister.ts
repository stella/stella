import { Result } from "better-result";
import * as v from "valibot";

import { pushDeviceTokenSchema } from "@stll/api-contract/mobile-push";
import type { PushDeviceRemovalResponse } from "@stll/api-contract/mobile-push";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { unregisterPushDevice } from "@/api/lib/push/push-devices";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Stop push alerts to a device, as the mobile app does when the person " +
    "signs out. Succeeds with removed: false when the device was not " +
    "registered, so a retried sign-out never fails.",
  // permissions-exempt: the write touches only the caller's own device rows
  // (user-scoped RLS); workspace:read is the access floor every member has.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "native_device" },
  realtime: noResourceSetUpdates(
    "A device registration belongs only to the caller and appears in no shared view.",
  ),
  access: "write",
  params: v.object({ token: pushDeviceTokenSchema }),
} satisfies HandlerConfig;

/** `DELETE /v1/me/push-devices/:token`: only the caller's own row. */
const unregisterPushDeviceEndpoint = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, user }) {
    const removed = yield* Result.await(
      safeDb(
        async (tx) =>
          await unregisterPushDevice(tx, {
            token: params.token,
            userId: user.id,
          }),
      ),
    );
    return Result.ok({ removed } satisfies PushDeviceRemovalResponse);
  },
);

declareAggregateMutation(unregisterPushDeviceEndpoint, {
  type: "independent",
  reason: "Deletes at most the caller's own device row by its token.",
});

export default unregisterPushDeviceEndpoint;
