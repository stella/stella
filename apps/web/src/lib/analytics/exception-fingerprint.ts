import { Result } from "better-result";

import { readFingerprintFields } from "@stll/errors";

import { telemetryErrorType } from "@/lib/analytics/error-diagnostics";

// Capture owners declare these keys in source. Engine-inferred symbols can
// contain computed user data and minified names, so they are never identity.
export type ExceptionFingerprintKey = `${string}:${string}`;

export const isExceptionFingerprintKey = (
  value: unknown,
): value is ExceptionFingerprintKey =>
  typeof value === "string" &&
  /^[A-Za-z][A-Za-z0-9_.-]{0,159}:[A-Za-z0-9_.%~-]{1,511}$/u.test(value);

type FingerprintEntry = {
  type: string;
};

/** Validated API response classifications; response text never enters identity. */
export type ApiErrorIdentity = {
  status: number;
  code?: string | undefined;
};

type ExceptionFingerprintInput = {
  entries: readonly FingerprintEntry[];
  key: ExceptionFingerprintKey;
  http?: ApiErrorIdentity | undefined;
  fields?: Readonly<Record<string, string>> | undefined;
};

// The innermost cause survives wrappers added by reporting boundaries. The
// explicit owner/path survives source moves, minification and code splitting.
export const fingerprintExceptionEvent = ({
  entries,
  key,
  http,
  fields,
}: ExceptionFingerprintInput): string =>
  JSON.stringify([
    entries.at(-1)?.type ?? "UnknownError",
    key,
    http?.status ?? null,
    http?.code ?? null,
    Object.entries(fields ?? {}).toSorted(([left], [right]) => {
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    }),
  ]);

/** Read classifications before stack redaction removes error objects and causes. */
const MAX_CAUSE_DEPTH = 6;
const MAX_PROTOTYPE_DEPTH = 16;

export const capturedExceptionIdentity = (error: unknown) =>
  Result.try(() => {
    let current = error;
    const seen = new Set<Error>();
    const fields = new Map<string, string>();
    const reads = new WeakMap<object, Map<string, unknown>>();
    const read = (value: object, key: string): unknown => {
      let cached = reads.get(value);
      if (cached === undefined) {
        cached = new Map();
        reads.set(value, cached);
      }
      if (cached.has(key)) {
        return cached.get(key);
      }
      const result: unknown = Reflect.get(value, key);
      cached.set(key, result);
      return result;
    };
    let type = telemetryErrorType(current);
    while (
      current instanceof Error &&
      !seen.has(current) &&
      seen.size < MAX_CAUSE_DEPTH
    ) {
      seen.add(current);
      type = telemetryErrorType(current);
      const prototypes: object[] = [];
      let prototype: unknown = Object.getPrototypeOf(current);
      while (
        typeof prototype === "object" &&
        prototype !== null &&
        prototypes.length < MAX_PROTOTYPE_DEPTH
      ) {
        prototypes.push(prototype);
        prototype = Object.getPrototypeOf(prototype);
      }
      const declared = readFingerprintFields({
        value: current,
        prototypes,
        read,
      });
      for (const [field, value] of Object.entries(declared ?? {})) {
        fields.set(`${type}.${field}`, value);
      }
      current = current.cause;
    }
    return { type, fields: Object.fromEntries(fields) };
  }).unwrapOr({ type: "UnknownError", fields: {} });

export const sanitizeFingerprintFields = (
  value: unknown,
): Record<string, string> =>
  Result.try(() => {
    const fields = new Map<string, string>();
    if (typeof value !== "object" || value === null) {
      return Object.fromEntries(fields);
    }
    for (const [key, field] of Object.entries(value)) {
      if (
        /^[A-Za-z][A-Za-z0-9_.-]{0,159}\.(?:reason|phase|stage|termination)(?:\.(?:reason|phase|stage|termination))*$/u.test(
          key,
        ) &&
        typeof field === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/u.test(field)
      ) {
        fields.set(key, field);
      }
    }
    return Object.fromEntries(fields);
  }).unwrapOr({});

/** Route templates come from the router, before dynamic parameters resolve. */
export const routeExceptionFingerprintKey = (
  routeTemplate: string,
): ExceptionFingerprintKey => `routeError:${encodeURIComponent(routeTemplate)}`;
