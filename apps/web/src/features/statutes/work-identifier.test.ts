import { describe, expect, test } from "bun:test";

import { workIdentifierFromEli } from "@/features/statutes/work-identifier";

describe("workIdentifierFromEli", () => {
  test("turns the ELI's year/number around into the citation form", () => {
    expect(workIdentifierFromEli("/eli/cz/act/2024/123")).toBe("123/2024");
    expect(workIdentifierFromEli("/eli/cz/sb/1961/141")).toBe("141/1961");
  });

  test("reads the work, not the consolidation the URL continues into", () => {
    expect(workIdentifierFromEli("/eli/cz/sb/2012/89/2014-01-01/cs")).toBe(
      "89/2012",
    );
  });

  test("keeps a number's letter suffix, which is part of the citation", () => {
    expect(workIdentifierFromEli("/eli/sk/zz/2020/62a")).toBe("62a/2020");
  });

  test("tolerates a trailing slash and a missing leading one", () => {
    expect(workIdentifierFromEli("eli/cz/act/2024/123/")).toBe("123/2024");
  });

  test("answers nothing when the ELI states no work number", () => {
    expect(workIdentifierFromEli("/eli/cz/act/2024")).toBeNull();
    expect(workIdentifierFromEli("/eli/eu/dir/consolidated")).toBeNull();
    expect(workIdentifierFromEli("")).toBeNull();
  });

  test("two years in a row are a range, not a work number", () => {
    expect(workIdentifierFromEli("/eli/cz/act/2024/2025")).toBeNull();
  });

  test("a number that could pass for a year is still not one", () => {
    // The segment before it is not a plausible year, so the pair is not a
    // work identifier however number-shaped both halves look.
    expect(workIdentifierFromEli("/eli/cz/act/12/34")).toBeNull();
  });
});
