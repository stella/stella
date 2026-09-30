import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { parseMultipartForm } from "@/api/lib/multipart-form-parser";

const fieldName = fc.oneof(
  fc.string({ maxLength: 24 }).filter((key) => !/[\r\n"]/u.test(key)),
  fc.constantFrom(
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "a.b",
    "a[0]",
  ),
);
const fieldValue = fc.oneof(
  fc.string({ maxLength: 128 }),
  fc.constantFrom(
    '{"a":1}',
    '["a","b"]',
    "null",
    "",
    "žluťoučký",
    "a\nb\rc\r\nd",
  ),
);
const entries = fc.array(fc.tuple(fieldName, fieldValue), { maxLength: 24 });
const normalizeWireNewlines = (value: string): string =>
  value.replace(/\r\n|\r|\n/gu, "\r\n");

test(
  "multipart field handling preserves wire values and order",
  async () => {
    await fc.assert(
      fc.asyncProperty(entries, async (pairs) => {
        const form = new FormData();
        for (const [key, value] of pairs) {
          form.append(key, value);
        }
        const request = new Request("https://example.test/", {
          method: "POST",
          body: form,
        });
        // oxlint-disable-next-line typescript/no-deprecated -- the boundary consumes the runtime's decoded form
        const parsed = parseMultipartForm(await request.formData());
        const keys = new Set(pairs.map(([key]) => key));
        for (const key of keys) {
          if (["__proto__", "constructor", "prototype"].includes(key)) {
            expect(Object.hasOwn(parsed, key)).toBe(false);
            continue;
          }
          const expected = pairs
            .filter(([name]) => name === key)
            .map(([, value]) => normalizeWireNewlines(value));
          const actual = parsed[key];
          expect(Array.isArray(actual) ? actual : [actual]).toEqual(expected);
          expect(Array.isArray(actual)).toBe(expected.length > 1);
        }
        expect(Object.keys(parsed).toSorted()).toEqual(
          [...keys]
            .filter(
              (key) => !["__proto__", "constructor", "prototype"].includes(key),
            )
            .toSorted(),
        );
        expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 50 }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "multipart file handling preserves content and repeated fields",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 256 }), {
          minLength: 1,
          maxLength: 8,
        }),
        async (contents) => {
          const form = new FormData();
          for (const [index, bytes] of contents.entries()) {
            form.append(
              "files",
              new File([bytes], `file-${index}.bin`, {
                type: "application/octet-stream",
              }),
            );
          }
          const request = new Request("https://example.test/", {
            method: "POST",
            body: form,
          });
          // oxlint-disable-next-line typescript/no-deprecated -- the boundary consumes the runtime's decoded form
          const body = parseMultipartForm(await request.formData());
          const field = body["files"];
          const files = Array.isArray(field) ? field : [field];
          expect(files).toHaveLength(contents.length);
          for (const [index, file] of files.entries()) {
            expect(file).toBeInstanceOf(File);
            if (typeof file !== "object" || file === null) {
              return;
            }
            expect(file.name).toBe(`file-${index}.bin`);
            expect(new Uint8Array(await file.arrayBuffer())).toEqual(
              contents.at(index),
            );
          }
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 30 }),
    );
  },
  propertyTestTimeout(5000),
);
