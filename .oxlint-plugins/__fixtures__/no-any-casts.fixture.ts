// Passive regression fixture for `no-any-casts/no-any-casts`.

declare const value: unknown;

// MUST flag: `as any` bypasses every structural guarantee.
// oxlint-disable-next-line no-any-casts/no-any-casts, typescript/no-explicit-any, typescript/no-unsafe-type-assertion -- fixture: TypeScript as-any casts must be rejected
export const asAny = value as any;

// MUST flag: angle-bracket any assertions are the same escape hatch.
// oxlint-disable-next-line no-any-casts/no-any-casts, typescript/no-explicit-any, typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- fixture: legacy any assertions must be rejected
export const angleAny = <any>value;

// Allowed: const assertions preserve literal information without using any.
export const literalTuple = ["workspace", "document"] as const;

// Allowed: satisfies checks a value without laundering its inferred type.
export const checkedTuple = ["workspace"] satisfies readonly string[];
