import { panic } from "better-result";

import { stableStringify } from "@stll/stable-stringify";
import type { StableStringifyInput } from "@stll/stable-stringify";

/** A selected Blob belongs to one submit intent; selecting another starts a new intent. */
export const createSubmitFingerprint = (createToken: () => string) => {
  const blobTokens = new WeakMap<Blob, string>();
  const normalize = (value: unknown): StableStringifyInput => {
    if (value instanceof Blob) {
      let token = blobTokens.get(value);
      if (token === undefined) {
        token = createToken();
        blobTokens.set(value, token);
      }
      return { selectedBlob: token };
    }
    if (value instanceof Date) {
      return value.toJSON();
    }
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint" ||
      typeof value === "symbol"
    ) {
      return value;
    }
    return panic("A create submission must contain serializable values");
  };
  return (body: unknown) => stableStringify(normalize(body));
};
