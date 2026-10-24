import { Result } from "better-result";

import { MAX_EXCEPTION_CAUSE_DEPTH } from "./exception-cause-chain";

// parser-output-unchanged: reads typed error dimensions for telemetry only; parsed values and rejection outcomes are unchanged.
const FINGERPRINT_KEYS = ["reason", "phase", "stage", "termination"] as const;
type FingerprintKey = (typeof FINGERPRINT_KEYS)[number];
const NESTED_DISCRIMINATOR_KEY = "kind";

/** Fingerprint dimensions are finite domain values vouched for by their error owner. */
type FingerprintField<
  TValue,
  TAllowedKey extends FingerprintKey | typeof NESTED_DISCRIMINATOR_KEY =
    FingerprintKey,
> = {
  [TKey in keyof TValue & TAllowedKey]: NonNullable<TValue[TKey]> extends string
    ? string extends NonNullable<TValue[TKey]>
      ? never
      : TKey
    : NonNullable<TValue[TKey]> extends object
      ? TKey extends FingerprintKey
        ? `${TKey}.${FingerprintField<NonNullable<TValue[TKey]>, FingerprintKey | typeof NESTED_DISCRIMINATOR_KEY>}`
        : never
      : never;
}[keyof TValue & TAllowedKey];

export type FingerprintFields<TInstance> =
  readonly FingerprintField<TInstance>[];

type ErrorClass<TInstance extends object> = abstract new (
  ...args: never
) => TInstance;

const declarations = new WeakMap<object, readonly string[]>();

/** Prototype identity prevents remote errors from opting in by copying a tag. */
export const declareFingerprintFields = <TInstance extends object>(
  errorClass: ErrorClass<TInstance>,
  fields: FingerprintFields<TInstance>,
): void => {
  const prototype: unknown = errorClass.prototype;
  if (typeof prototype === "object" && prototype !== null) {
    declarations.set(prototype, fields);
  }
};

type ReadFingerprintFieldsOptions = {
  value: object;
  prototypes: readonly object[];
  read: (value: object, key: string) => unknown;
};

// Match the bounded prototype readers; declared dimensions currently use at most
// three fields and two path components. Cause depth also bounds nested dimensions.
const MAX_FINGERPRINT_FIELDS = 16;
const MAX_PROTOTYPE_DEPTH = 16;
const MAX_FIELD_PATH_CHARS =
  MAX_EXCEPTION_CAUSE_DEPTH * ("termination".length + 1) - 1;

type FingerprintFieldsResult = {
  fields: Readonly<Record<string, string>> | undefined;
  status: "complete" | "read_failed";
};

/** Every structural read is guarded; property reads retain the caller's memoization. */
export const readFingerprintFields = ({
  value,
  prototypes,
  read,
}: ReadFingerprintFieldsOptions): FingerprintFieldsResult => {
  let status: FingerprintFieldsResult["status"] = "complete";
  const attempt = <T>(operation: () => T): T | undefined => {
    const result = Result.try(() => ({ read: operation() }));
    if (Result.isError(result)) {
      status = "read_failed";
      return undefined;
    }
    return result.value.read;
  };
  const fields = new Set<string>();
  const collect = (metadata: unknown): void => {
    if (!attempt(() => Array.isArray(metadata))) {
      return;
    }
    // Array.isArray does not narrow through the guarded operation.
    if (typeof metadata !== "object" || metadata === null) {
      return;
    }
    const length = attempt(() => read(metadata, "length"));
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      status = "read_failed";
      return;
    }
    if (length > MAX_FINGERPRINT_FIELDS) {
      status = "read_failed";
    }
    for (
      let index = 0;
      index < Math.min(length, MAX_FINGERPRINT_FIELDS);
      index += 1
    ) {
      const field = attempt(() => read(metadata, String(index)));
      if (typeof field !== "string") {
        continue;
      }
      if (field.length > MAX_FIELD_PATH_CHARS) {
        status = "read_failed";
        continue;
      }
      const path = field.split(".");
      if (path.length > MAX_EXCEPTION_CAUSE_DEPTH) {
        status = "read_failed";
        continue;
      }
      if (
        path.every(
          (key, index) =>
            FINGERPRINT_KEYS.some((dimension) => dimension === key) ||
            (index > 0 &&
              index === path.length - 1 &&
              key === NESTED_DISCRIMINATOR_KEY),
        )
      ) {
        fields.add(field);
      }
    }
  };
  const prototypeCount = attempt(() => prototypes.length);
  if (prototypeCount === undefined || prototypeCount > MAX_PROTOTYPE_DEPTH) {
    status = "read_failed";
  }
  for (
    let index = 0;
    index < Math.min(prototypeCount ?? 0, MAX_PROTOTYPE_DEPTH);
    index += 1
  ) {
    const prototype = attempt(() => prototypes[index]);
    if (prototype === undefined) {
      continue;
    }
    collect(declarations.get(prototype));
    if (!attempt(() => Object.hasOwn(prototype, "constructor"))) {
      continue;
    }
    const constructor = attempt(() => read(prototype, "constructor"));
    if (
      typeof constructor !== "function" ||
      !attempt(() =>
        Object.hasOwn(constructor, "stellaExceptionFingerprintFields"),
      ) ||
      attempt(() => read(constructor, "prototype")) !== prototype
    ) {
      continue;
    }
    collect(
      attempt(() => read(constructor, "stellaExceptionFingerprintFields")),
    );
  }
  const result = new Map<string, string>();
  for (const field of fields) {
    let current: unknown = value;
    for (const key of field.split(".")) {
      if (typeof current !== "object" || current === null) {
        current = undefined;
        break;
      }
      const object = current;
      current = attempt(() => read(object, key));
    }
    if (typeof current === "string") {
      result.set(field, current);
    }
  }
  return {
    fields: fields.size === 0 ? undefined : Object.fromEntries(result),
    status,
  };
};
