type Primitive = string | number | boolean | bigint | symbol | null | undefined;

type IsAny<TValue> = 0 extends 1 & TValue ? true : false;

// Identical types carry no excess. Stopping there also keeps recursive
// declared types (a document AST) from recursing without bound. Mutual
// assignability is not identity: `{ a; b? }` and `{ a }` accept each other.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the generic signature IS the identity probe: TypeScript compares deferred conditional signatures only for identical operands
type IdentityProbe<TValue> = <TProbe>() => TProbe extends TValue ? 1 : 2;

type IsIdentical<TLeft, TRight> =
  IdentityProbe<TLeft> extends IdentityProbe<TRight> ? true : false;

type IsUnknown<TValue> =
  IsAny<TValue> extends true ? false : unknown extends TValue ? true : false;

type ArrayElement<TValue> = TValue extends readonly (infer TElement)[]
  ? TElement
  : never;

type ObjectBranches<TValue> = TValue extends readonly unknown[]
  ? never
  : TValue extends Primitive
    ? never
    : TValue;

type KeysOfUnion<TValue> = TValue extends unknown ? keyof TValue : never;

type PropertyOfUnion<TValue, TKey extends PropertyKey> = TValue extends unknown
  ? TKey extends keyof TValue
    ? TValue[TKey]
    : never
  : never;

type AssignableBranches<TActual, TDeclared> = TDeclared extends unknown
  ? TActual extends TDeclared
    ? TDeclared
    : never
  : never;

// The declared branches an actual object can stand in for: those it is
// assignable to, or every object branch when assignability is decided
// elsewhere (a widened literal the declared type narrows).
type MatchingBranches<TActual, TDeclared> = [
  AssignableBranches<TActual, TDeclared>,
] extends [never]
  ? TDeclared
  : AssignableBranches<TActual, TDeclared>;

type ObjectExcessPaths<
  TActual,
  TDeclared,
  TPath extends string,
  TBranches = MatchingBranches<TActual, TDeclared>,
> = {
  // A key that can only be absent (`policy?: never` closing a union branch)
  // never reaches the output. Numeric keys serialise as JSON properties too.
  [TKey in keyof TActual & (string | number)]-?: [
    Exclude<TActual[TKey], undefined>,
  ] extends [never]
    ? never
    : TKey extends KeysOfUnion<TBranches>
      ? OutputExcessPaths<
          TActual[TKey],
          PropertyOfUnion<TBranches, TKey>,
          `${TPath}.${TKey}`
        >
      : `${TPath}.${TKey}`;
}[keyof TActual & (string | number)];

/**
 * Paths of properties a produced value's static type carries that the
 * declared output type does not. TypeScript accepts such values wherever the
 * declared type is expected (excess-property checks stop at fresh object
 * literals), while a strict output schema rejects them at runtime, so this
 * names the gap at compile time. `never` means the value fits.
 */
export type OutputExcessPaths<
  TActual,
  TDeclared,
  TPath extends string = "output",
> =
  IsAny<TActual> extends true
    ? never
    : IsAny<TDeclared> extends true
      ? never
      : unknown extends TDeclared
        ? never
        : IsIdentical<TActual, TDeclared> extends true
          ? never
          : TActual extends Primitive
            ? never
            : TActual extends readonly unknown[]
              ? OutputExcessPaths<
                  ArrayElement<TActual>,
                  ArrayElement<TDeclared>,
                  `${TPath}[]`
                >
              : TActual extends (...args: never[]) => unknown
                ? never
                : ObjectExcessPaths<TActual, ObjectBranches<TDeclared>, TPath>;

/**
 * The parameter type of a checked output constructor: the produced value,
 * which must name no property the declared output lacks. The declared type
 * comes from the constructor's return context (a typed handler's return
 * type); a call without one has nothing to check against and is rejected, so
 * an unchecked output cannot be built by accident.
 */
// `NoInfer<TDeclared>` is the literal's contextual type: without it a
// discriminant such as `type: "exact"` widens to `string`, the inferred value
// no longer satisfies the declared type, and inference falls back to the
// declared type itself, which has no excess to report.
export type CheckedOutput<TActual, TDeclared> = TActual &
  NoInfer<TDeclared> &
  (IsUnknown<TDeclared> extends true
    ? { missingDeclaredOutputType: never }
    : [OutputExcessPaths<TActual, TDeclared>] extends [never]
      ? unknown
      : { undeclaredOutputPaths: OutputExcessPaths<TActual, TDeclared> });
