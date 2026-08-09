// Passive regression fixture for
// `no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast`.
// Suppressions become unused, and fail CI, if a must-flag case stops matching.

type RegistryCompany = { id: string };
type RegistryState = { company: RegistryCompany; raw: unknown };
type RawPayload = unknown;
// oxlint-disable-next-line typescript/consistent-type-definitions
interface RegistryStateInterface {
  company: RegistryCompany;
  raw: RawPayload;
}
type JsonValue = boolean | number | string | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type ReadonlyJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

declare const response: { json: () => Promise<never> };
declare const genericResponse: { json: <T>() => Promise<T> };
declare const raw: string;
declare const schema: unknown;
declare const useFallback: boolean;
declare const fallbackCompany: RegistryCompany;
declare const maybeFallbackCompany: RegistryCompany | undefined;
declare const state: { company: RegistryCompany; raw: unknown };
declare const aliasState: RegistryState;
declare const interfaceState: RegistryStateInterface;
declare const isRegistryCompany: (value: unknown) => value is RegistryCompany;
declare const v: {
  parse: (inputSchema: unknown, input: unknown) => RegistryCompany;
  safeParse: (inputSchema: unknown, input: unknown) => unknown;
};

export const assertedResponse = async () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  (await response.json()) as RegistryCompany;

export const genericResponseClaim = async () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  await genericResponse.json<RegistryCompany>();

export const genericUnknownResponse = async () =>
  await genericResponse.json<unknown>();

export const genericRawAliasResponse = async () =>
  await genericResponse.json<RawPayload>();

export const assertedParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/no-unsafe-type-assertion
  JSON.parse(raw) as RegistryCompany;

export const assertedComputedParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/dot-notation, typescript/no-unsafe-type-assertion
  JSON["parse"](raw) as RegistryCompany;

export const assertedGlobalParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/no-unsafe-type-assertion
  globalThis.JSON.parse(raw) as RegistryCompany;

export const angleBracketAssertedParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  <RegistryCompany>JSON.parse(raw);

const parseJson = JSON.parse;
export const assertedAliasedParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/no-unsafe-type-assertion
  parseJson(raw) as RegistryCompany;

export const annotatedParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const parsed: RegistryCompany = JSON.parse(raw);
  return parsed;
};

export const indirectlyAnnotatedParse = () => {
  const rawValue = JSON.parse(raw);
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const parsed: RegistryCompany = rawValue;
  return parsed;
};

export const conditionallyAnnotatedParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const parsed: RegistryCompany = useFallback
    ? fallbackCompany
    : JSON.parse(raw);
  return parsed;
};

export const logicallyAnnotatedParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const parsed: RegistryCompany = maybeFallbackCompany ?? JSON.parse(raw);
  return parsed;
};

export const annotatedObjectLiteralParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const payload: { company: RegistryCompany } = {
    company: JSON.parse(raw),
  };
  return payload;
};

export const annotatedSpreadParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const payload: RegistryState = { ...JSON.parse(raw) };
  return payload;
};

export const annotatedArrayLiteralParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const companies: RegistryCompany[] = [JSON.parse(raw)];
  return companies;
};

export const annotatedOpenObjectLiteralParse = () => {
  const payload: { raw: unknown } = { raw: JSON.parse(raw) };
  return payload;
};

export const satisfiesParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  JSON.parse(raw) satisfies RegistryCompany;

export const satisfiesObjectLiteralParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  ({ company: JSON.parse(raw), raw: null }) satisfies RegistryState;

export const assertedRawAlias = () => JSON.parse(raw) as RawPayload;

export const assignedParse = () => {
  let parsed: RegistryCompany;
  if (raw === "") {
    parsed = v.parse(schema, null);
  } else {
    // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
    parsed = JSON.parse(raw);
  }
  return parsed;
};

export const indirectlyAssignedParse = () => {
  const rawValue = JSON.parse(raw);
  let parsed: RegistryCompany;
  if (raw !== "") {
    // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
    parsed = rawValue;
  } else {
    parsed = v.parse(schema, null);
  }
  return parsed;
};

export const assignedMemberParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  state.company = JSON.parse(raw);
};

export const indirectlyAssignedMemberParse = () => {
  const rawValue = JSON.parse(raw);
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  state.company = rawValue;
};

export const assignedAliasMemberParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  aliasState.company = JSON.parse(raw);
};

export const assignedInterfaceMemberParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  interfaceState.company = JSON.parse(raw);
};

export const indirectlyAssertedParse = () => {
  const rawValue = JSON.parse(raw);
  return (
    // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/no-unsafe-type-assertion
    rawValue as RegistryCompany
  );
};

// oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
export const annotatedFunctionReturn = (): RegistryCompany => JSON.parse(raw);

export const annotatedLocalReturn =
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  (): RegistryCompany => {
    const parsed = JSON.parse(raw);
    return parsed;
  };

export const annotatedAliasedLocalReturn =
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  (): RegistryCompany => {
    const parsed = JSON.parse(raw);
    const payload = parsed;
    return payload;
  };

export const annotatedAssignedLocalReturn =
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  (): RegistryCompany => {
    // oxlint-disable-next-line eslint/prefer-const
    let parsed;
    parsed = JSON.parse(raw);
    return parsed;
  };

export const validatedLocalReturn = (): RegistryCompany => {
  const rawValue = JSON.parse(raw);
  const parsed = v.parse(schema, rawValue);
  return parsed;
};

export const guardedInferredLocalReturn =
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  (): RegistryCompany => {
    const parsed = JSON.parse(raw);
    if (!isRegistryCompany(parsed)) {
      return v.parse(schema, null);
    }
    return parsed;
  };

export const guardedUnknownLocalReturn = (): RegistryCompany => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRegistryCompany(parsed)) {
    return v.parse(schema, null);
  }
  return parsed;
};

export const annotatedAsyncFunctionReturn =
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  async (): Promise<RegistryCompany> => await response.json();

// Raw passthrough is intentionally open to additive upstream fields.
export const unknownResponse = async () => {
  const value: unknown = await response.json();
  return value;
};

// JSON.parse guarantees a JSON value without claiming a business shape.
export const rawJsonValue = () => {
  const value: JsonValue = JSON.parse(raw);
  return value;
};

export const readonlyRawJsonValue = () => {
  const value: ReadonlyJsonValue = JSON.parse(raw);
  return value;
};

export const rawJsonFunctionReturn = (): JsonValue => JSON.parse(raw);
export const rawJsonAliasFunctionReturn = (): RawPayload => JSON.parse(raw);
export const rawJsonAsyncFunctionReturn = async (): Promise<unknown> =>
  await response.json();
export const rawJsonAliasAsyncFunctionReturn = async (): Promise<RawPayload> =>
  await response.json();

export const rawJsonAssignment = () => {
  let value: unknown;
  if (raw === "") {
    value = null;
  } else {
    value = JSON.parse(raw);
  }
  return value;
};

export const rawJsonMemberAssignment = () => {
  state.raw = JSON.parse(raw);
  aliasState.raw = JSON.parse(raw);
  interfaceState.raw = JSON.parse(raw);
};

export const inferredUnknownAssignment = (input: unknown) => {
  let value = input;
  if (raw !== "") {
    value = JSON.parse(raw);
  }
  return value;
};

declare const responseBuilder: { json: (payload: unknown) => RegistryCompany };
export const responseBuilderCall = () =>
  responseBuilder.json({ id: "company" });

// Closed and open schemas both validate before producing a domain value.
export const parsedResponse = async () =>
  v.parse(schema, await response.json());
export const looselyParsedResponse = async () =>
  v.safeParse(schema, await response.json());
