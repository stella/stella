import { expect, test } from "bun:test";

import { parseSource as parseFresh } from "../packages/scripts/src/syntax-tree";
import { parseSyntax } from "./parse-memo";

test("memoized source trees match fresh parses across module and grammar extensions", () => {
  const extensions = ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"];
  for (const text of ["const value = 1;", "function read() { return 2; }"]) {
    for (const extension of extensions) {
      const fileName = `source.${extension}`;
      expect({
        fileName,
        program: parseSyntax({ fileName, text }).program,
      }).toEqual({ fileName, program: parseFresh(fileName, text).program });
    }
  }
});
