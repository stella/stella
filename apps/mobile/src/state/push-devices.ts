import { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** The person's own devices that the server sends notifications to. */
const PUSH_DEVICES_PATH = "/v1/me/push-devices";

/** Which APNs gateway serves a build: Xcode-signed development builds get sandbox tokens. */
export type ApsEnvironment = "sandbox" | "production";

export type PushDevice = {
  /** The APNs device token, as hex. */
  readonly token: string;
  readonly apsEnvironment: ApsEnvironment;
  readonly bundleId: string;
  readonly appVersion: string;
  /** The language the alerts are written in. */
  readonly locale: string;
};

/**
 * Tells the server this phone takes the person's notifications, or that it
 * still does: registering again refreshes the device rather than adding one.
 */
export const registerPushDevice = async ({
  device,
  fetch,
  source,
}: {
  readonly device: PushDevice;
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { ...device, platform: "ios" },
        fetch,
        method: "PUT",
        path: PUSH_DEVICES_PATH,
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** Stops the server sending to this phone, as the person signs out. */
export const unregisterPushDevice = async ({
  fetch,
  source,
  token,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly token: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        fetch,
        method: "DELETE",
        path: `${PUSH_DEVICES_PATH}/${encodeURIComponent(token)}`,
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });
