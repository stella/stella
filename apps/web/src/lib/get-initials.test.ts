import { describe, expect, it } from "bun:test";

import { getInitials } from "./get-initials";

describe("getInitials", () => {
  it("returns two initials for multi-word names", () => {
    expect(getInitials("Eva Schmidt")).toBe("ES");
    expect(getInitials("Frank Horvát")).toBe("FH");
  });

  it("takes first two words only", () => {
    expect(getInitials("Jan van Houten")).toBe("JV");
    expect(getInitials("Mary Jane Watson")).toBe("MJ");
  });

  it("returns two characters for single-word names", () => {
    expect(getInitials("John")).toBe("JO");
    expect(getInitials("X")).toBe("X");
  });

  it("handles CJK names (no spaces)", () => {
    expect(getInitials("王小明")).toBe("王小");
    expect(getInitials("田中太郎")).toBe("田中");
  });

  it("handles Greenlandic / long single-word names", () => {
    expect(getInitials("Pipaluk")).toBe("PI");
  });

  it("handles Korean names with space", () => {
    expect(getInitials("김 민수")).toBe("김민");
  });

  it("returns ? for null", () => {
    expect(getInitials(null)).toBe("?");
  });

  it("returns ? for empty string", () => {
    expect(getInitials("")).toBe("?");
    expect(getInitials("   ")).toBe("?");
  });

  it("trims leading/trailing whitespace", () => {
    expect(getInitials("  John Smith  ")).toBe("JS");
  });

  it("handles multiple spaces between words", () => {
    expect(getInitials("John   Smith")).toBe("JS");
  });

  it("uppercases Latin initials", () => {
    expect(getInitials("eva schmidt")).toBe("ES");
  });
});
