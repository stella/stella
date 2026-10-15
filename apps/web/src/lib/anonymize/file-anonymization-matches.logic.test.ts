import { expect, test } from "bun:test";

import {
  findFileAnonymizationMatches,
  prepareFileAnonymizationText,
} from "./file-anonymization-matches.logic";

test("whitespace normalization preserves source spans across Unicode and line breaks", () => {
  for (const separator of [" ", "\n", "\r\n", "\t  \n", "\u00a0"]) {
    for (const prefix of ["", "😀 ", "é\n"]) {
      const source = `${prefix}Example${separator}Holdings suffix`;
      const prepared = prepareFileAnonymizationText(source);
      expect(
        findFileAnonymizationMatches(prepared, "Example Holdings"),
      ).toEqual([
        {
          start: prefix.length,
          end: prefix.length + `Example${separator}Holdings`.length,
        },
      ]);
    }
  }
});
