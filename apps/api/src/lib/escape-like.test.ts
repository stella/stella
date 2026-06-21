import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { escapeLike } from "./escape-like";

const SPECIAL = new Set(["%", "_", "\\"]);

/**
 * Walks the escaped pattern left to right treating "\\" as an escape
 * character: a backslash consumes the following character as a literal.
 * Returns true when every "%", "_", and "\\" in the output is escaped,
 * i.e. preceded by an escaping backslash and never left to act as a SQL
 * LIKE metacharacter.
 */
const hasNoUnescapedSpecial = (escaped: string): boolean => {
  for (let i = 0; i < escaped.length; i++) {
    const char = escaped.at(i);
    if (char !== "\\") {
      // A bare metacharacter that was not consumed by a preceding
      // backslash means escaping failed.
      if (char !== undefined && SPECIAL.has(char)) {
        return false;
      }
      continue;
    }
    // Backslash escapes the next character; the next character must
    // exist (a dangling trailing backslash would itself be unescaped).
    if (i + 1 >= escaped.length) {
      return false;
    }
    i++;
  }
  return true;
};

describe("escapeLike", () => {
  test("escapes the backslash escape character", () => {
    expect<string>(escapeLike("a\\b")).toBe("a\\\\b");
  });

  test("escapes the percent wildcard", () => {
    expect<string>(escapeLike("100%")).toBe("100\\%");
  });

  test("escapes the underscore wildcard", () => {
    expect<string>(escapeLike("a_b")).toBe("a\\_b");
  });

  test("escapes all metacharacters together", () => {
    expect<string>(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });

  test("leaves non-metacharacters untouched", () => {
    expect<string>(escapeLike("plain text 123")).toBe("plain text 123");
  });

  test("returns the empty string unchanged", () => {
    expect<string>(escapeLike("")).toBe("");
  });

  test("escapes backslash before introduced escapes (no double-escaping)", () => {
    // A user backslash followed by a percent must become an escaped
    // backslash followed by an escaped percent, not a single "\\%"
    // that would read as one escaped percent.
    expect<string>(escapeLike("\\%")).toBe("\\\\\\%");
  });

  test("invariant: output never contains an unescaped metacharacter", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(hasNoUnescapedSpecial(escapeLike(input))).toBe(true);
      }),
    );
  });

  test("invariant: stripping escapes recovers the original input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const escaped = escapeLike(input);
        // Removing each escaping backslash (consume-next-char parse)
        // must reconstruct the original string exactly.
        let recovered = "";
        for (let i = 0; i < escaped.length; i++) {
          if (escaped.at(i) === "\\") {
            i++;
          }
          recovered += escaped.at(i);
        }
        expect(recovered).toBe(input);
      }),
    );
  });

  test("fuzz: hand-rolled random metacharacter-heavy strings stay escaped", () => {
    const alphabet = ["%", "_", "\\", "a", "z", "0", " ", "\n", "汉"];
    for (let iteration = 0; iteration < 1000; iteration++) {
      const length = Math.floor(Math.random() * 32);
      let input = "";
      for (let i = 0; i < length; i++) {
        const pick = alphabet.at(Math.floor(Math.random() * alphabet.length));
        if (pick !== undefined) {
          input += pick;
        }
      }
      expect(hasNoUnescapedSpecial(escapeLike(input))).toBe(true);
    }
  });

  test("invariant: escaped length equals input length plus metachar count", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const metaCount = Array.from(input).filter((char) =>
          SPECIAL.has(char),
        ).length;
        expect(escapeLike(input).length).toBe(input.length + metaCount);
      }),
    );
  });
});
