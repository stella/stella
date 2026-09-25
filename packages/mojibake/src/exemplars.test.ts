import { expect, test } from "bun:test";

import { extractExemplars } from "../scripts/extract-exemplars.js";
import { CLDR_EXEMPLARS, CLDR_VERSION } from "./exemplars.generated.js";

test("the exemplar table is what the pinned CLDR package extracts to", () => {
  const { version, exemplars } = extractExemplars();
  expect(CLDR_VERSION).toBe(version);
  // Serialized: the table's literal types and the extraction's records are
  // different types of the same data.
  expect(JSON.stringify(CLDR_EXEMPLARS)).toBe(JSON.stringify(exemplars));
});
