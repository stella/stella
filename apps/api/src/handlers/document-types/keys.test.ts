import { describe, expect, test } from "bun:test";

import {
  slugifyDocumentTypeKey,
  uniqueDocumentTypeKey,
} from "@/api/handlers/document-types/keys";

describe("slugifyDocumentTypeKey", () => {
  test("lowercases, collapses separators, trims", () => {
    expect(slugifyDocumentTypeKey("Master Services Agreement")).toBe(
      "master-services-agreement",
    );
    expect(slugifyDocumentTypeKey("  NDA / MNDA  ")).toBe("nda-mnda");
    expect(slugifyDocumentTypeKey("Data Processing Agreement (DPA)")).toBe(
      "data-processing-agreement-dpa",
    );
  });

  test("falls back to a stable key when nothing is slug-able", () => {
    // A label with no [a-z0-9] characters must still yield a usable key.
    expect(slugifyDocumentTypeKey("契約書")).toBe("type");
    expect(slugifyDocumentTypeKey("—")).toBe("type");
  });

  test("clips to the column budget without a trailing hyphen", () => {
    const key = slugifyDocumentTypeKey("a ".repeat(200));
    expect(key.length).toBeLessThanOrEqual(120);
    expect(key.endsWith("-")).toBe(false);
  });
});

describe("uniqueDocumentTypeKey", () => {
  test("returns the base when free", () => {
    expect(uniqueDocumentTypeKey("nda", new Set())).toBe("nda");
    expect(uniqueDocumentTypeKey("nda", new Set(["spa"]))).toBe("nda");
  });

  test("suffixes past collisions", () => {
    expect(uniqueDocumentTypeKey("nda", new Set(["nda"]))).toBe("nda-2");
    expect(uniqueDocumentTypeKey("nda", new Set(["nda", "nda-2"]))).toBe(
      "nda-3",
    );
  });

  test("always resolves to a free key regardless of collision density", () => {
    const taken = new Set(["nda", "nda-2", "nda-3", "nda-4"]);
    const key = uniqueDocumentTypeKey("nda", taken);
    expect(taken.has(key)).toBe(false);
    expect(key.startsWith("nda")).toBe(true);
  });
});
