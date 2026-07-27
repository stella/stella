import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { loadDictionaryBundle } from "../../../data/dictionaries/cities";

describe("dictionary bundle scoping", () => {
  test("empty country scope keeps default city dictionaries", async () => {
    const bundle = await loadDictionaryBundle({ countries: [] });

    expect(bundle.cities.length).toBeGreaterThan(0);
    expect(Object.keys(bundle.citiesByCountry)).toContain("CZ");
  });

  test("unsupported non-empty name language scope keeps names empty", async () => {
    const bundle = await loadDictionaryBundle({ nameLanguages: ["pt-br"] });

    expect(bundle.firstNames).toEqual({});
    expect(bundle.surnames).toEqual({});
    expect(Object.values(bundle.denyListMeta)).not.toContainEqual(
      expect.objectContaining({ category: "Names" }),
    );
  });
});
