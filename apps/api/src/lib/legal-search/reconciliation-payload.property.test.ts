import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { fingerprintReconciliationPayload } from "@/api/lib/legal-search/reconciliation-payload";

const reverseObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toReversed()
        .map(([key, child]) => [key, reverseObjectKeys(child)]),
    );
  }
  return value;
};

test("listing fingerprints survive JSON persistence and object key order", () => {
  assertProperty(
    "listing fingerprints survive JSON persistence and object key order",
    fc.property(fc.jsonValue(), (payload) => {
      const serialized = JSON.stringify(payload);
      const stored: unknown = JSON.parse(serialized);
      const fingerprint = fingerprintReconciliationPayload(payload);
      expect(fingerprintReconciliationPayload(stored)).toBe(fingerprint);
      expect(fingerprintReconciliationPayload(reverseObjectKeys(payload))).toBe(
        fingerprint,
      );
      expect(
        fingerprintReconciliationPayload({
          value: payload,
          omitted: undefined,
        }),
      ).toBe(fingerprintReconciliationPayload({ value: stored }));
      expect(fingerprintReconciliationPayload([payload, undefined])).toBe(
        fingerprintReconciliationPayload([stored, null]),
      );
    }),
  );
});

test("listing fingerprints distinguish publisher revisions and JSON shapes", () => {
  assertProperty(
    "listing fingerprints distinguish publisher revisions and JSON shapes",
    fc.property(fc.jsonValue(), (payload) => {
      expect(
        fingerprintReconciliationPayload({ payload, revision: 1 }),
      ).not.toBe(fingerprintReconciliationPayload({ payload, revision: 2 }));
      expect(fingerprintReconciliationPayload({ payload })).not.toBe(
        fingerprintReconciliationPayload([payload]),
      );
      expect(
        fingerprintReconciliationPayload([
          { revision: 1, payload },
          { revision: 2, payload },
        ]),
      ).not.toBe(
        fingerprintReconciliationPayload([
          { revision: 2, payload },
          { revision: 1, payload },
        ]),
      );
      expect(fingerprintReconciliationPayload([payload, null])).not.toBe(
        fingerprintReconciliationPayload([payload]),
      );
    }),
  );
});

test("listing fingerprints retain every persisted JSON object key", () => {
  assertProperty(
    "listing fingerprints retain every persisted JSON object key",
    fc.property(
      fc.constantFrom("__proto__", "constructor", "toString"),
      fc.jsonValue(),
      (key, payload) => {
        const original = Object.fromEntries([[key, { payload, revision: 1 }]]);
        const corrected = Object.fromEntries([[key, { payload, revision: 2 }]]);
        expect(fingerprintReconciliationPayload(original)).not.toBe(
          fingerprintReconciliationPayload(corrected),
        );
        expect(fingerprintReconciliationPayload(original)).not.toBe(
          fingerprintReconciliationPayload({}),
        );
        expect(fingerprintReconciliationPayload({ a: original })).not.toBe(
          fingerprintReconciliationPayload({ a: corrected }),
        );
        expect(fingerprintReconciliationPayload({ a: original })).not.toBe(
          fingerprintReconciliationPayload({ a: {} }),
        );
      },
    ),
  );
});
