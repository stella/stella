import { api as client } from "@/lib/api";

declare const analytics: { captureError: (error: unknown) => void };
declare const toAPIError: (error: unknown) => unknown;

const response = await client.items.get();
// oxlint-disable-next-line no-raw-api-error-telemetry/no-raw-api-error-telemetry
analytics.captureError(response.error);
const { error: failure } = response;
// oxlint-disable-next-line no-raw-api-error-telemetry/no-raw-api-error-telemetry
analytics.captureError(failure);
// expect-clean: no-raw-api-error-telemetry/no-raw-api-error-telemetry
analytics.captureError(toAPIError(failure));
