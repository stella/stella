import { describe, expect, test } from "bun:test";

import { sortDirectionHint } from "./sorts";

describe("sortDirectionHint", () => {
  test("words sort alphabetically", () => {
    expect(sortDirectionHint("text", false)).toBe("A→Z");
    expect(sortDirectionHint("text", true)).toBe("Z→A");
  });

  test("a person sorts by name, so it reads alphabetically too", () => {
    expect(sortDirectionHint("person", false)).toBe("A→Z");
  });

  test("numbers and money sort numerically", () => {
    expect(sortDirectionHint("int", false)).toBe("1→9");
    expect(sortDirectionHint("money", true)).toBe("9→1");
  });

  test("dates read as arrows", () => {
    expect(sortDirectionHint("date", false)).toBe("↑");
    expect(sortDirectionHint("date", true)).toBe("↓");
  });

  test("a type with no idiom falls back to the icon", () => {
    expect(sortDirectionHint("clip", false)).toBeNull();
    expect(sortDirectionHint(undefined, false)).toBeNull();
  });
});
