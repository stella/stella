import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { isRecord } from "@/api/lib/type-guards";

import { PublisherPageError, validatePublisherPage } from "./publisher-page";

test("arbitrary response bodies only pass a JSON listing contract when they parse and contain its array", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.json(),
        fc.array(fc.jsonValue()).map((items) => JSON.stringify({ items })),
      ),
      (body) => {
        const validated = validatePublisherPage({
          body,
          adapterKey: "cz-regional",
          cursor: null,
          expectation: {
            kind: "json",
            shape: (value) => isRecord(value) && Array.isArray(value["items"]),
          },
        });
        if (validated.isErr()) {
          expect(validated.error).toBeInstanceOf(PublisherPageError);
          return;
        }
        const parsed: unknown = JSON.parse(body);
        expect(isRecord(parsed) && Array.isArray(parsed["items"])).toBe(true);
        expect(validated.value).toEqual(parsed);
      },
    ),
    propertyConfig({ numRuns: 500 }),
  );
});
