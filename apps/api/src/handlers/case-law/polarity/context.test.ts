import { describe, expect, test } from "bun:test";

import { extractContext } from "@/api/handlers/case-law/polarity/context";

describe("the window around a citation", () => {
  test("is the section's own text either side of the mention", () => {
    const sections = [
      { text: "Nesouvisející oddíl." },
      { text: "Soud odkázal na usnesení sp. zn. 3 Tdo 759/2020 a uzavřel." },
    ];

    expect(extractContext(sections, "sp. zn. 3 Tdo 759/2020", 1)).toBe(
      sections[1]?.text ?? "",
    );
  });

  test("is null when the section does not carry the citation", () => {
    expect(extractContext([{ text: "Bez citace." }], "21 Cdo 1/20", 0)).toBe(
      null,
    );
  });

  test("comes back composed, whatever form the publisher served", () => {
    // 4 Tdo 348/2023 reaches the pipeline with "Ú" decomposed. Every reader
    // of this window matches precomposed words against it, so a decomposed
    // section would match none of them.
    const sentence =
      "(nález Ústavního soudu sp. zn. I. ÚS 1135/17, ze dne 1. 11. 2017)";
    const decomposed = sentence.normalize("NFD");
    expect(decomposed).not.toBe(sentence);

    const context = extractContext(
      [{ text: decomposed }],
      "I. ÚS 1135/17".normalize("NFD"),
      0,
    );

    expect(context).toBe(sentence);
  });
});
