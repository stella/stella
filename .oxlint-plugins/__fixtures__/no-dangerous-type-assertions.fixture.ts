// Passive regression fixture for
// `no-dangerous-type-assertions/no-dangerous-type-assertions`.

type Payload = {
  required: string;
};

// MUST flag: an object-literal cast can conceal a missing required field.
// oxlint-disable-next-line no-dangerous-type-assertions/no-dangerous-type-assertions, typescript/no-unsafe-type-assertion -- fixture: object literals must be checked instead of cast
export const hiddenMissingField = {} as Payload;

// MUST flag: angle-bracket assertions conceal the same invalid state.
// oxlint-disable-next-line no-dangerous-type-assertions/no-dangerous-type-assertions, typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- fixture: legacy object-literal casts must be rejected
export const legacyHiddenMissingField = <Payload>{};

// Allowed: satisfies checks every required property without widening.
export const checkedPayload = { required: "present" } satisfies Payload;

// Allowed: `as const` controls literal widening and is explicitly exempt.
export const immutablePayload = { required: "present" } as const;
