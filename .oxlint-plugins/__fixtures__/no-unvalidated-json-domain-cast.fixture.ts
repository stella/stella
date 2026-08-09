// Passive regression fixture for
// `no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast`.
// Suppressions become unused, and fail CI, if a must-flag case stops matching.

type RegistryCompany = { id: string };
type JsonValue = boolean | number | string | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

declare const response: { json: () => Promise<never> };
declare const genericResponse: { json: <T>() => Promise<T> };
declare const raw: string;
declare const schema: unknown;
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

export const assertedParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/no-unsafe-type-assertion
  JSON.parse(raw) as RegistryCompany;

export const assertedComputedParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/dot-notation, typescript/no-unsafe-type-assertion
  JSON["parse"](raw) as RegistryCompany;

export const assertedGlobalParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/no-unsafe-type-assertion
  globalThis.JSON.parse(raw) as RegistryCompany;

const parseJson = JSON.parse;
export const assertedAliasedParse = () =>
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast, typescript/no-unsafe-type-assertion
  parseJson(raw) as RegistryCompany;

export const annotatedParse = () => {
  // oxlint-disable-next-line no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast
  const parsed: RegistryCompany = JSON.parse(raw);
  return parsed;
};

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

// Closed and open schemas both validate before producing a domain value.
export const parsedResponse = async () =>
  v.parse(schema, await response.json());
export const looselyParsedResponse = async () =>
  v.safeParse(schema, await response.json());
