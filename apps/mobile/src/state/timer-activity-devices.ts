import { Result } from "better-result";
import * as v from "valibot";

import type {
  TimerActivityActionKey,
  TimerActivityDeviceRegistration,
} from "@stll/api-contract/timer-activity";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** The person's phones that show their timer on the Lock Screen. */
const DEVICES_PATH = "/v1/me/timer-activity-devices";

const devicePath = (deviceId: string) =>
  `${DEVICES_PATH}/${encodeURIComponent(deviceId)}`;

const registrationResponseSchema = v.object({
  actionKey: v.nullable(
    v.object({
      key: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      expiresAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
  ),
});

/**
 * Tells the server what this phone holds now: the tokens that start and
 * update its timer's activity, and whether updates may name the timer. The
 * whole state each time, so the latest registration is the one that counts.
 * Answers the Lock Screen button key the registration asked for, if issued.
 */
export const registerTimerActivityDevice = async ({
  deviceId,
  fetch,
  registration,
  source,
}: {
  readonly deviceId: string;
  readonly fetch: Fetch;
  readonly registration: TimerActivityDeviceRegistration;
  readonly source: AccessTokenSource;
}): Promise<Result<TimerActivityActionKey | null, ApiError>> =>
  await Result.gen(async function* () {
    const answer = yield* Result.await(
      requestApi({
        body: registration,
        fetch,
        method: "PUT",
        path: devicePath(deviceId),
        schema: registrationResponseSchema,
        source,
      }),
    );
    return Result.ok(answer.actionKey);
  });

/** Stops the server updating this phone's timer, as the person signs out. */
export const unregisterTimerActivityDevice = async ({
  deviceId,
  fetch,
  source,
}: {
  readonly deviceId: string;
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        fetch,
        method: "DELETE",
        path: devicePath(deviceId),
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });
