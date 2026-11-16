import { expect, test } from "bun:test";

import { SITEMAP_RANGE_INDEX } from "./case-law-sitemap-indexes";
import countryDatePublishedIndexes from "./online-migration-entries/indexes-case-law-decisions-country-date-published-idx";

test("the sitemap range index is the date index the online phase builds", () => {
  // The finalized entry keeps its own declaration; the sitemap names the same
  // index, so a change to either shows here.
  expect(countryDatePublishedIndexes.values).toEqual([SITEMAP_RANGE_INDEX]);
});
