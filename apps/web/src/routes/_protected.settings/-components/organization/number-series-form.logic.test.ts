import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { NumberSeries } from "@/lib/organization/number-series";
import { toSafeId } from "@/lib/safe-id";

import {
  DEFAULT_NUMBER_SERIES_PATTERN,
  numberSeriesFormSchema,
  numberSeriesPatch,
} from "./number-series-form.logic";

const schema = numberSeriesFormSchema({
  required: "Required",
  invalidField: "Invalid field",
});
const raw = {
  name: " Main invoices ",
  documentType: "invoice",
  pattern: DEFAULT_NUMBER_SERIES_PATTERN,
  padding: 4,
  sellerProfileId: null,
} satisfies v.InferInput<typeof schema>;
const original = {
  id: toSafeId<"numberSeries">("series-main"),
  name: "Main invoices",
  documentType: "invoice",
  pattern: DEFAULT_NUMBER_SERIES_PATTERN,
  padding: 4,
  sellerProfileId: toSafeId<"sellerProfile">("seller-main"),
  isDefault: false,
  createdAt: "2026-09-30T12:00:00Z",
  updatedAt: "2026-09-30T12:00:00Z",
} satisfies NumberSeries;

describe("number series form", () => {
  test("normalizes names and seller selection without interpreting numbering tokens", () => {
    const values = v.parse(schema, {
      ...raw,
      sellerProfileId: " seller-main ",
      pattern: " PREFIX-{CUSTOM}-{SEQ} ",
    });
    expect(values).toEqual({
      name: "Main invoices",
      documentType: "invoice",
      pattern: "PREFIX-{CUSTOM}-{SEQ}",
      padding: 4,
      sellerProfileId: toSafeId<"sellerProfile">("seller-main"),
    });
  });

  test("omits an unselected seller from create requests", () => {
    for (const sellerProfileId of [null, "", "  "]) {
      const values = v.parse(schema, { ...raw, sellerProfileId });
      expect(Object.hasOwn(values, "sellerProfileId")).toBe(false);
      expect(values).toEqual({
        name: "Main invoices",
        documentType: "invoice",
        pattern: DEFAULT_NUMBER_SERIES_PATTERN,
        padding: 4,
      });
    }
  });

  test("enforces only API field bounds and document types", () => {
    for (const padding of [0, 7, 1.5]) {
      expect(() => v.parse(schema, { ...raw, padding })).toThrow(
        "Invalid field",
      );
    }
    for (const padding of [1, 6]) {
      expect(v.parse(schema, { ...raw, padding }).padding).toBe(padding);
    }
    expect(() => v.parse(schema, { ...raw, name: "  " })).toThrow("Required");
    expect(() => v.parse(schema, { ...raw, name: "x".repeat(129) })).toThrow(
      "Invalid field",
    );
    for (const pattern of ["1234", "x".repeat(129)]) {
      expect(() => v.parse(schema, { ...raw, pattern })).toThrow(
        "Invalid field",
      );
    }
    for (const documentType of ["invoice", "advance", "credit_note"] as const) {
      expect(v.parse(schema, { ...raw, documentType }).documentType).toBe(
        documentType,
      );
    }
    expect(
      v.safeParse(schema, { ...raw, documentType: "receipt" }).success,
    ).toBe(false);
  });
});

describe("number series edits", () => {
  test("omits unchanged pattern and padding when changing only the name", () => {
    const next = v.parse(schema, {
      ...raw,
      name: "Renamed invoices",
      sellerProfileId: original.sellerProfileId,
    });
    expect(numberSeriesPatch({ original, next })).toEqual({
      name: "Renamed invoices",
    });
    expect(
      numberSeriesPatch({ original, next: { ...next, name: original.name } }),
    ).toEqual({});
  });

  test("sends seller clearing as null and preserves changed padding and pattern", () => {
    const next = v.parse(schema, { ...raw, padding: 1, pattern: "{YY}-{SEQ}" });
    expect(numberSeriesPatch({ original, next })).toEqual({
      sellerProfileId: null,
      padding: 1,
      pattern: "{YY}-{SEQ}",
    });
  });
});
