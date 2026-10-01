import { Result } from "better-result";

import { ACTION_ADMISSION_REFUSALS } from "@stll/api-contract/action-admission";

import { toAPIError } from "@/lib/errors/api";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

type ObserveActionAdmissionResponseOptions = {
  notifyRefusal: (error: unknown) => boolean;
  captureError: (error: unknown) => void;
};

export const observeActionAdmissionResponse = async (
  response: Response,
  { notifyRefusal, captureError }: ObserveActionAdmissionResponseOptions,
): Promise<void> => {
  if (
    !Object.values(ACTION_ADMISSION_REFUSALS).some(
      (refusal) => refusal.status === response.status,
    ) ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return;
  }
  const observed = await Result.tryPromise({
    try: async () => {
      const value: unknown = await response.clone().json();
      notifyRefusal(toAPIError({ status: response.status, value }));
    },
    // Parser failures can contain response data; capture only the observer boundary.
    catch: () =>
      new ClientTelemetryError({
        area: "action-admission-response",
        message: "Could not observe an action response.",
      }),
  });
  if (observed.isErr()) {
    captureError(observed.error);
  }
};
