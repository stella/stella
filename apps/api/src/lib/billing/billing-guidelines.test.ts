import { expect, test } from "bun:test";

import { extractBillingGuidelineSections } from "./billing-guidelines";

test("billing rule sections retain ATX heading levels, Unicode titles and optional closing hashes", () => {
  const titles = [
    "Narratives",
    "Časové záznamy",
    "الفوترة",
    "Codes # exceptions",
  ];
  for (let level = 1; level <= 6; level += 1) {
    for (const title of titles) {
      for (const suffix of ["", "   ", " ###", "###"]) {
        const heading = `${"#".repeat(level)}\t ${title}${suffix}`;
        expect(extractBillingGuidelineSections(heading)).toEqual([
          "Preamble",
          title,
        ]);
      }
    }
  }
});

test("billing rule sections recognize line boundaries without treating blank headings as following text", () => {
  for (const newline of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    const content = [
      "Preamble text",
      "#   ",
      "Ordinary text",
      "## Rule",
      "####### Too deep",
      " # Indented",
      "#No separator",
      "### Final ###",
    ].join(newline);
    expect(extractBillingGuidelineSections(content)).toEqual([
      "Preamble",
      "Rule",
      "Final",
    ]);
  }
});

test("long heading suffixes are processed without backtracking or losing title text", () => {
  for (const length of [1, 1000, 100_000]) {
    const spaces = " ".repeat(length);
    const hashes = "#".repeat(length);
    expect(
      extractBillingGuidelineSections(`# Rule${spaces}${hashes}${spaces}`),
    ).toEqual(["Preamble", "Rule"]);
    expect(extractBillingGuidelineSections(`# ${spaces}\nBody text`)).toEqual([
      "Preamble",
    ]);
    expect(extractBillingGuidelineSections(`${hashes}Invalid`)).toEqual([
      "Preamble",
    ]);
  }
});
