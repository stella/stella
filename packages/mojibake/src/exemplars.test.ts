import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  extractExemplars,
  generatedHeader,
} from "../scripts/extract-exemplars.js";
import { CLDR_EXEMPLARS, CLDR_VERSION } from "./exemplars.generated.js";

test("the exemplar table is what the pinned CLDR package extracts to", () => {
  const { version, exemplars } = extractExemplars();
  expect(CLDR_VERSION).toBe(version);
  // Serialized: the table's literal types and the extraction's records are
  // different types of the same data.
  expect(JSON.stringify(CLDR_EXEMPLARS)).toBe(JSON.stringify(exemplars));
});

test("the table and the package carry the CLDR data's own licence notice", () => {
  const extracted = extractExemplars();
  expect(extracted.license).toContain("SPDX-License-Identifier: Unicode-3.0");
  const table = readFileSync(
    new URL("exemplars.generated.ts", import.meta.url),
    "utf-8",
  );
  expect(table.startsWith(generatedHeader(extracted))).toBe(true);
  const notice = readFileSync(new URL("../NOTICE", import.meta.url), "utf-8");
  expect(notice).toContain(extracted.license.trim());
});
