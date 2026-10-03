import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { sanitizeFilename } from "@/api/lib/sanitize-filename";

import { resolveSiblingName } from "./sibling-name";

test("sibling names retain free originals and select the lowest free bounded suffix", () => {
  assertProperty(
    "sibling names retain free originals and select the lowest free bounded suffix",
    fc.property(
      fc.constantFrom(
        "contract.docx",
        "contract_2.docx",
        `${"a".repeat(250)}.docx`,
        `${"😀".repeat(125)}.txt`,
        `a.${"x".repeat(253)}`,
      ),
      fc.array(fc.integer({ min: 1, max: 30 }), { maxLength: 30 }),
      fc.boolean(),
      (rawName, numbers, occupied) => {
        const name = sanitizeFilename(rawName);
        const dot = name.lastIndexOf(".");
        const base = name.slice(0, dot).replace(/_\d+$/u, "");
        const extension = name.slice(dot);
        const candidate = (n: number) => {
          const suffix = `_${n}`;
          const boundedExt = extension.slice(0, 255 - suffix.length);
          const boundedBase = base
            .slice(0, 255 - suffix.length - boundedExt.length)
            .replace(/[\uD800-\uDBFF]$/u, "");
          return `${boundedBase}${suffix}${boundedExt}`;
        };
        const siblingNames = new Set(numbers.map(candidate));
        siblingNames.add("contract_final.docx");
        if (occupied) {
          siblingNames.add(name);
        }
        const result = resolveSiblingName({ name, siblingNames });
        expect(siblingNames.has(result)).toBe(false);
        expect(result.length).toBeLessThanOrEqual(255);
        expect(result.toWellFormed()).toBe(result);
        if (!siblingNames.has(name)) {
          expect(result).toBe(name);
          return;
        }
        let lowest = 1;
        while (siblingNames.has(candidate(lowest))) {
          lowest += 1;
        }
        expect(result).toBe(candidate(lowest));
      },
    ),
  );
});
