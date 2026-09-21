import { describe, expect, test } from "bun:test";

import { extractContexts } from "@/api/handlers/case-law/polarity/context";

describe("the windows around a citation", () => {
  test("is the section's own text either side of the mention", () => {
    const sections = [
      { text: "Nesouvisející oddíl." },
      { text: "Soud odkázal na usnesení sp. zn. 3 Tdo 759/2020 a uzavřel." },
    ];

    expect(extractContexts(sections, "sp. zn. 3 Tdo 759/2020", 1)).toEqual([
      sections[1]?.text ?? "",
    ]);
  });

  test("is null when the section does not carry the citation", () => {
    expect(extractContexts([{ text: "Bez citace." }], "21 Cdo 1/20", 0)).toBe(
      null,
    );
  });

  test("returns one window per mention, in reading order", () => {
    // A recital of the line the case belongs to, then, far enough away that
    // no 200-character window reaches across, the sentence that rejects it.
    const recital =
      "Dosavadní praxe se ustálila v názoru (srov. rozsudek sp. zn. 23 Cdo 5068/2014).";
    const filler = "Další odůvodnění. ".repeat(40);
    const rejection =
      "Od závěrů rozsudku sp. zn. 23 Cdo 5068/2014 se velký senát odchyluje.";
    const windows = extractContexts(
      [{ text: `${recital}${filler}${rejection}` }],
      "sp. zn. 23 Cdo 5068/2014",
      0,
    );

    expect(windows).toHaveLength(2);
    expect(windows?.[0]).toContain("srov.");
    expect(windows?.[0]).not.toContain("odchyluje");
    expect(windows?.[1]).toContain("odchyluje");
    expect(windows?.[1]).not.toContain("srov.");
  });

  test("merges mentions whose windows overlap into one", () => {
    const text =
      "Rozsudek sp. zn. 21 Cdo 1/20 a na něj navazující usnesení; k tomu " +
      "srov. opět sp. zn. 21 Cdo 1/20 a další.";

    const windows = extractContexts([{ text }], "sp. zn. 21 Cdo 1/20", 0);

    expect(windows).toEqual([text]);
  });

  test("comes back composed, whatever form the publisher served", () => {
    // 4 Tdo 348/2023 reaches the pipeline with "Ú" decomposed. Every reader
    // of a window matches precomposed words against it, so a decomposed
    // section would match none of them.
    const sentence =
      "(nález Ústavního soudu sp. zn. I. ÚS 1135/17, ze dne 1. 11. 2017)";
    const decomposed = sentence.normalize("NFD");
    expect(decomposed).not.toBe(sentence);

    const windows = extractContexts(
      [{ text: decomposed }],
      "I. ÚS 1135/17".normalize("NFD"),
      0,
    );

    expect(windows).toEqual([sentence]);
  });
});
