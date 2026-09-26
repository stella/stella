import { describe, expect, test } from "bun:test";

import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@/api/lib/legal-search/ingestion-constants";

import {
  getSourceRegistration,
  listAdapterKeys,
  listSourceRegistrations,
} from "./adapter-registry";
import { checkedSourceRegistrations } from "./source-registrations";

describe("source discovery fails closed on contradictory identities", () => {
  test.each([ADAPTER_KEYS.CZ_NS, IMPORT_SOURCE_KEYS.COURTLISTENER])(
    "%s: lookup checks the declared key instead of trusting the source",
    (key) => {
      const source = getSourceRegistration(key)?.source;
      expect(source).toBeDefined();
      if (source === undefined)
        throw new Error("Missing registered source fixture");
      const original = source.key;
      Object.defineProperty(source, "key", {
        configurable: true,
        value: "wrong-key",
      });
      try {
        expect(() => getSourceRegistration(key)).toThrow(
          `Source registry key mismatch for ${key}`,
        );
        expect(() => listSourceRegistrations()).toThrow(
          `Source registry key mismatch for ${key}`,
        );
        expect(listAdapterKeys()).toEqual(Object.values(ADAPTER_KEYS));
      } finally {
        Object.defineProperty(source, "key", {
          configurable: true,
          value: original,
        });
      }
    },
  );

  test.each(["crawl", "import"])(
    "a duplicate %s key cannot overwrite another capability",
    (capability) => {
      const registrations = [
        { key: "shared", capability: "crawl", source: { key: "shared" } },
        { key: "shared", capability, source: { key: "shared" } },
      ];
      expect(() => checkedSourceRegistrations(registrations)).toThrow(
        "Duplicate source registry key: shared",
      );
      expect(() =>
        checkedSourceRegistrations(registrations.toReversed()),
      ).toThrow("Duplicate source registry key: shared");
    },
  );
});
