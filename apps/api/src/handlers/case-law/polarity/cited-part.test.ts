import { describe, expect, test } from "bun:test";

import { classifyCitedPart } from "@/api/handlers/case-law/polarity/cited-part";

const opinions = [
  { language: "cs", text: "odlišného stanoviska", part: "dissent" },
  { language: "sk", text: "odlišné stanovisko", part: "dissent" },
  { language: "en", text: "dissenting opinion", part: "dissent" },
  { language: "cs", text: "konkurující stanovisko", part: "concurrence" },
  { language: "sk", text: "súhlasné stanovisko", part: "concurrence" },
  { language: "en", text: "concurring opinion", part: "concurrence" },
  { language: "cs", text: "většinový názor", part: "majority" },
  { language: "sk", text: "väčšinové stanovisko", part: "majority" },
  { language: "en", text: "majority opinion", part: "majority" },
] as const;

describe("the cited opinion", () => {
  test.each(opinions)(
    "identifies an explicit $language $part opinion",
    ({ language, text, part }) => {
      expect(classifyCitedPart([`Citation X: ${text}.`], language)).toBe(part);
      expect(
        classifyCitedPart([`Citation X: ${text.normalize("NFD")}.`], language),
      ).toBe(part);
    },
  );

  test("does not infer an opinion from an unnamed or conflicting reference", () => {
    expect(classifyCitedPart(["The cited decision by Judge A."], "en")).toBe(
      "not-stated",
    );
    expect(classifyCitedPart(["srov. rozhodnutí X"], "cs")).toBe("not-stated");
    expect(
      classifyCitedPart(["majority opinion", "dissenting opinion"], "en"),
    ).toBe("not-stated");
    expect(classifyCitedPart(["dissenting opinion"], "cs")).toBe("not-stated");
    expect(classifyCitedPart(["dissenting opinion"], "und")).toBe("not-stated");
  });
});
