import { expect, test } from "bun:test";

import {
  findFileAnonymizationMatches,
  normalizeWhitespaceWithOffsets,
} from "./file-anonymization-matches.logic";

test("whitespace normalization preserves source spans across Unicode and line breaks", () => {
  for (const separator of [" ", "\n", "\r\n", "\t  \n", "\u00a0"]) {
    for (const prefix of ["", "😀 ", "é\n"]) {
      const source = `${prefix}Example${separator}Holdings suffix`;
      const normalized = normalizeWhitespaceWithOffsets(source);
      expect(
        findFileAnonymizationMatches(normalized, "Example Holdings"),
      ).toEqual([
        {
          start: prefix.length,
          end: prefix.length + `Example${separator}Holdings`.length,
        },
      ]);
    }
  }
});
