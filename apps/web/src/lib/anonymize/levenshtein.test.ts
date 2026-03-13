import { levenshtein } from "./levenshtein";

describe("levenshtein()", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns length of other string when one is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("computes single substitution", () => {
    expect(levenshtein("cat", "car")).toBe(1);
  });

  it("computes single insertion", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });

  it("computes single deletion", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  it("handles diacritics difference", () => {
    expect(levenshtein("Müller", "Muller")).toBe(1);
    expect(levenshtein("Novák", "Novak")).toBe(1);
  });

  it("handles completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  it("is symmetric", () => {
    expect(levenshtein("abc", "ab")).toBe(levenshtein("ab", "abc"));
  });

  it("handles longer realistic names", () => {
    expect(levenshtein("Česká spořitelna", "Ceska sporitelna")).toBe(3);
  });
});
