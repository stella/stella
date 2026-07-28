import { describe, expect, test } from "bun:test";

import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import { parseCompanyPage } from "./parse.js";

describe("SUDREG normalized projection", () => {
  test("preserves address, capital, legal form, URL, and warnings", async () => {
    const html = await Bun.file(
      new URL("__fixtures__/company.html", import.meta.url),
    ).text();
    const company = parseCompanyPage(html, "080000014");
    expect(company).not.toBeNull();
    if (!company) {
      return;
    }
    company.warnings.push({ type: "unexpected-address-format" });
    const entity = toNormalizedEntity(company);
    expect(entity.registryId.scheme).toBe("HR-MBS");
    expect(String(entity.registryId.value)).toBe("080000014");
    expect(entity.address).toMatchObject({
      availability: "available",
      value: { houseNumber: "10" },
    });
    expect(entity.shareCapital).toMatchObject({
      availability: "available",
      value: { text: "850.068.230,00 euro" },
    });
    expect(entity.warnings).toEqual({
      availability: "available",
      value: [{ code: "unexpected-address-format" }],
    });
    expect(entity.status).toEqual({ availability: "not-supported" });
  });

  test("derives a search row without inventing status", async () => {
    const html = await Bun.file(
      new URL("__fixtures__/company.html", import.meta.url),
    ).text();
    const company = parseCompanyPage(html, "080000014");
    expect(company).not.toBeNull();
    if (!company) {
      return;
    }
    const result = toNormalizedSearchResult(company);
    expect(result.status).toEqual({ availability: "not-supported" });
  });
});
