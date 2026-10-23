import type { ExceptionScope } from "@stll/errors";

import {
  capturedApiErrorIdentity,
  capturedExceptionIdentity,
  fingerprintExceptionEvent,
  fingerprintExceptionScope,
} from "@/lib/analytics/exception-fingerprint";
import type { ExceptionFingerprintKey } from "@/lib/analytics/exception-fingerprint";

const stableHash = (value: string): string => {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 4_294_967_296;
  }
  return hash.toString(16).padStart(8, "0").toUpperCase();
};

type FingerprintTelemetryErrorOptions = {
  key: ExceptionFingerprintKey;
  scope: ExceptionScope;
};

/** A compact presentation of the same identity used for issue grouping. */
export const fingerprintTelemetryError = (
  error: unknown,
  { key, scope }: FingerprintTelemetryErrorOptions,
): string => {
  const { types, fields } = capturedExceptionIdentity(error);
  return `ERRFP-${stableHash(fingerprintExceptionEvent({ entries: types.map((type) => ({ type })), key, scopeIdentity: fingerprintExceptionScope(scope), http: capturedApiErrorIdentity(error), fields }))}`;
};
