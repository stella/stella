import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { scanMediaType } from "@/api/lib/file-scan/media-type";
import { OOXML_MIME_TYPES } from "@/api/lib/files/encrypted-ooxml";

const token = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,20}$/u);
const parameter = fc
  .tuple(token, token)
  .map(([name, value]) => `${name}=${value}`);
const padding = fc.constantFrom("", " ", "  ", "\t");

describe("scan media type", () => {
  test("a declared type compares equal to its essence however it is spelled", () => {
    assertProperty(
      "a declared type compares equal to its essence however it is spelled",
      fc.property(
        token,
        token,
        fc.array(parameter, { maxLength: 3 }),
        padding,
        fc.boolean(),
        (type, subtype, parameters, pad, upper) => {
          const essence = `${type}/${subtype}`;
          const spelled = [
            `${pad}${upper ? essence.toUpperCase() : essence}${pad}`,
            ...parameters,
          ].join(";");
          expect(scanMediaType(spelled)).toBe(scanMediaType(essence));
          expect(scanMediaType(scanMediaType(spelled))).toBe(
            scanMediaType(spelled),
          );
        },
      ),
    );
  });

  test("lookup sets hold the same essence a declared type normalizes to", () => {
    const docx =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(
      OOXML_MIME_TYPES.has(scanMediaType(`${docx.toUpperCase()}; v=1`)),
    ).toBe(true);
  });
});
