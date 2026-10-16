// parser-output-unchanged: reads typed error dimensions for telemetry only; parsed values and rejection outcomes are unchanged.
/** Fingerprint dimensions are finite domain values vouched for by their error owner. */
type FingerprintField<TValue> = {
  [
    TKey in keyof TValue & ("reason" | "phase" | "stage" | "termination")
  ]: NonNullable<TValue[TKey]> extends string
    ? string extends NonNullable<TValue[TKey]>
      ? never
      : TKey
    : NonNullable<TValue[TKey]> extends object
      ? `${TKey}.${FingerprintField<NonNullable<TValue[TKey]>>}`
      : never;
}[keyof TValue & ("reason" | "phase" | "stage" | "termination")];

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

/** The caller supplies its guarded, memoized reader so each property is read once. */
export const readFingerprintFields = ({
  value,
  prototypes,
  read,
}: ReadFingerprintFieldsOptions):
  | Readonly<Record<string, string>>
  | undefined => {
  const fields = prototypes.flatMap((prototype) => {
    const registered = declarations.get(prototype) ?? [];
    if (!Object.hasOwn(prototype, "constructor")) {
      return registered;
    }
    const constructor = read(prototype, "constructor");
    if (
      typeof constructor !== "function" ||
      !Object.hasOwn(constructor, "stellaExceptionFingerprintFields")
    ) {
      return registered;
    }
    const metadata = read(constructor, "stellaExceptionFingerprintFields");
    if (!Array.isArray(metadata)) {
      return registered;
    }
    const staticFields = metadata.filter(
      (field): field is string =>
        typeof field === "string" &&
        /^(?:reason|phase|stage|termination)(?:\.(?:reason|phase|stage|termination))*$/u.test(
          field,
        ),
    );
    return [...registered, ...staticFields];
  });
  if (fields.length === 0) {
    return undefined;
  }
  const result = new Map<string, string>();
  for (const field of fields) {
    let current: unknown = value;
    for (const key of field.split(".")) {
      if (typeof current !== "object" || current === null) {
        current = undefined;
        break;
      }
      current = read(current, key);
    }
    if (typeof current === "string") {
      result.set(field, current);
    }
  }
  return Object.fromEntries(result);
};
