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

type ErrorClass<TInstance extends object> = abstract new (
  ...args: never
) => TInstance;

const declarations = new WeakMap<object, readonly string[]>();

/** Prototype identity prevents remote errors from opting in by copying a tag. */
export const declareFingerprintFields = <TInstance extends object>(
  errorClass: ErrorClass<TInstance>,
  fields: readonly FingerprintField<TInstance>[],
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
  const fields = prototypes.flatMap(
    (prototype) => declarations.get(prototype) ?? [],
  );
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
