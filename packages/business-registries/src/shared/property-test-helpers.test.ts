import { Result } from "better-result";
import { expect } from "bun:test";
import fc from "fast-check";

import { RegistryError } from "./errors.js";
import { isRecord } from "./guards.js";

export const registryString: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 160 }),
  fc.constantFrom(
    "",
    " ",
    "\u00a0",
    "e\u0301",
    "中文😀",
    "\ud800",
    "\udfff",
    "\u202e",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "2026-02-30",
    "9999-99-99",
    "0",
    "NaN",
  ),
  fc
    .tuple(
      fc.constantFrom("9", "§", " ", "\u00a0", "\u2003", "/", "\ud800"),
      fc.integer({ min: 1000, max: 8000 }),
    )
    .map(([fragment, count]) => fragment.repeat(count)),
);

export const nullableRegistryString: fc.Arbitrary<string | null> = fc.option(
  registryString,
  { nil: null },
);
export const registryValue: fc.Arbitrary<unknown> = fc.oneof(
  registryString,
  fc.jsonValue({ maxDepth: 3 }),
);
export const registryExtras: fc.Arbitrary<Record<string, unknown>> =
  fc.dictionary(fc.string({ maxLength: 20 }), registryValue, { maxKeys: 5 });

export const expectRegistryOutcome = <T>(operation: () => T): T | undefined => {
  const result = Result.try({
    try: () => ({ value: operation() }),
    catch: (error) => error,
  });
  if (Result.isError(result)) {
    expect(result.error).toBeInstanceOf(RegistryError);
    return undefined;
  }
  return result.value.value;
};

export const expectNullableString = (value: unknown): void => {
  expect(value === null || typeof value === "string").toBe(true);
};

export const expectRegistryResponses = async <T>(
  responseOf: (url: string) => unknown,
  operation: () => Promise<T>,
): Promise<T | undefined> => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request) => {
      requests += 1;
      return Response.json(
        responseOf(url instanceof Request ? url.url : String(url)),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const result = await Result.tryPromise({
    try: operation,
    catch: (error) => error,
  });
  globalThis.fetch = originalFetch;
  expect(requests).toBeGreaterThan(0);
  if (Result.isError(result)) {
    expect(result.error).toBeInstanceOf(RegistryError);
    return undefined;
  }
  return result.value;
};

export const expectRegistryResponse = async <T>(
  payload: unknown,
  operation: () => Promise<T>,
): Promise<T | undefined> => expectRegistryResponses(() => payload, operation);

type RegistryFieldMutation = "missing" | "null" | "wrong-type";

export const registryMutation: fc.Arbitrary<RegistryFieldMutation> =
  fc.constantFrom("missing", "null", "wrong-type");

type RegistryMutationOptions = {
  payload: unknown;
  selected: number;
  mutation: RegistryFieldMutation;
};

type MutationLocation =
  | { type: "record"; record: Record<string, unknown>; key: string }
  | { type: "array"; array: unknown[]; index: number };

const registryMutationLocations = (
  payload: unknown,
  mutation: RegistryFieldMutation,
): MutationLocation[] => {
  const locations: MutationLocation[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        locations.push({ type: "array", array: value, index });
        visit(entry);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      locations.push({ type: "record", record: value, key });
      visit(child);
    }
  };
  visit(payload);
  return mutation === "null"
    ? locations.filter((location) => {
        switch (location.type) {
          case "record":
            return location.record[location.key] !== null;
          case "array":
            return location.array[location.index] !== null;
          default:
            return location satisfies never;
        }
      })
    : locations;
};

const mistypedRegistryValue = (value: unknown): unknown =>
  value !== null && typeof value === "object" ? 42 : { unexpected: true };

export const mutatedRegistryPayload = ({
  payload,
  selected,
  mutation,
}: RegistryMutationOptions): unknown => {
  const copy: unknown = structuredClone(payload);
  const locations = registryMutationLocations(copy, mutation);
  expect(locations.length).toBeGreaterThan(0);
  const location = locations.at(selected % locations.length);
  expect(location).toBeDefined();
  if (location === undefined) {
    return copy;
  }
  switch (location.type) {
    case "record": {
      if (mutation === "missing") {
        Reflect.deleteProperty(location.record, location.key);
        break;
      }
      location.record[location.key] =
        mutation === "null"
          ? null
          : mistypedRegistryValue(location.record[location.key]);
      break;
    }
    case "array": {
      if (mutation === "missing") {
        location.array.splice(location.index, 1);
        break;
      }
      location.array[location.index] =
        mutation === "null"
          ? null
          : mistypedRegistryValue(location.array[location.index]);
      break;
    }
    default:
      location satisfies never;
  }
  expect(copy).not.toEqual(payload);
  return copy;
};

export const forEachRegistryMutation = async (
  payload: unknown,
  check: (mutated: unknown) => Promise<void>,
): Promise<void> => {
  for (const mutation of ["missing", "null", "wrong-type"] as const) {
    const count = registryMutationLocations(payload, mutation).length;
    if (mutation !== "null") {
      expect(count).toBeGreaterThan(0);
    }
    for (let selected = 0; selected < count; selected += 1) {
      await check(mutatedRegistryPayload({ payload, selected, mutation }));
    }
  }
};
