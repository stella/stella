import { panic, Result, TaggedError } from "better-result";

import { createSha256 } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";

import { toJsonValue } from "@/api/lib/json-value";

class ReconciliationPayloadSerializationError extends TaggedError(
  "ReconciliationPayloadSerializationError",
)<{
  message: string;
  cause: unknown;
}> {}

/** Capture detached JSON with the same omitted keys and null array slots the driver persists. */
export const snapshotReconciliationPayload = (payload: unknown) =>
  Result.try({
    try: () => {
      const serialized =
        JSON.stringify(payload) ||
        panic("Reconciliation payload must have a JSON representation");
      const decoded: unknown = JSON.parse(serialized);
      return toJsonValue(decoded);
    },
    catch: (cause) =>
      new ReconciliationPayloadSerializationError({
        message: "Reconciliation payload cannot be serialized",
        cause,
      }),
  }).unwrap("Reconciliation payload must be JSON serializable.");

/** Fingerprint the JSON the driver persists, including omitted object keys and null array slots. */
export const fingerprintReconciliationPayload = (payload: unknown): string => {
  const normalized = snapshotReconciliationPayload(payload);
  const hasher = createSha256();
  hasher.update(stableStringify(normalized));
  return hasher.digest("hex");
};
