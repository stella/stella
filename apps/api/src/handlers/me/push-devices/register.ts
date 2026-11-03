import { panic, Result } from "better-result";

import { pushDeviceRegistrationSchema } from "@stll/api-contract/mobile-push";
import type { PushDeviceRegistrationResponse } from "@stll/api-contract/mobile-push";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { registerPushDevice } from "@/api/lib/push/push-devices";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Register the device the stella mobile app runs on for push alerts, or " +
    "refresh its registration. Idempotent per device token: registering " +
    "again updates the app version, language and organization and keeps one " +
    "row. Alerts name no client, matter or document.",
  // permissions-exempt: the write touches only the caller's own device rows
  // (user-scoped RLS); workspace:read is the access floor every member has.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "native_device" },
  realtime: noResourceSetUpdates(
    "A device registration belongs only to the caller and appears in no shared view.",
  ),
  access: "write",
  body: pushDeviceRegistrationSchema,
} satisfies HandlerConfig;

/**
 * `PUT /v1/me/push-devices`. The device is filed under the caller and the
 * organization their session (for the app, the access token's membership)
 * is in; neither comes from the body.
 */
const registerPushDeviceEndpoint = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
    const row = yield* Result.await(
      safeDb(
        async (tx) =>
          await registerPushDevice(tx, {
            organizationId: session.activeOrganizationId,
            registration: body,
            userId: user.id,
          }),
      ),
    );
    if (row === undefined) {
      // The upsert targets the caller's own row, which RETURNING always yields.
      return panic("Push device upsert returned no row");
    }
    return Result.ok({
      device: {
        platform: row.platform,
        token: row.token,
        environment: row.environment,
        bundleId: row.bundleId,
        appVersion: row.appVersion,
        locale: row.locale,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      },
    } satisfies PushDeviceRegistrationResponse);
  },
);

declareAggregateMutation(registerPushDeviceEndpoint, {
  type: "independent",
  reason:
    "Upserts the caller's own device row by its token and trims the caller's oldest devices; no aggregate spans other rows.",
});

export default registerPushDeviceEndpoint;
