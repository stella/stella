import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("font aliases", () => {
  test("do not map bold Office aliases to regular local font faces", () => {
    const css = readFileSync(
      new URL("font-aliases.css", import.meta.url),
      "utf-8",
    );
    const boldBlocks = css.match(
      /@font-face\s*{[^}]*font-weight:\s*700;[^}]*}/g,
    );

    expect(boldBlocks).not.toBeNull();
    for (const block of boldBlocks ?? []) {
      expect(block).not.toContain('local("Tinos")');
      expect(block).not.toContain('local("Caladea")');
      expect(block).not.toContain('local("Carlito")');
      expect(block).not.toContain('local("Arimo")');
      expect(block).not.toContain('local("Cousine")');
    }
  });
});
