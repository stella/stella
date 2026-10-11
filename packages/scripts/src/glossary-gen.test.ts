import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formattedLikeRepository } from "../../../scripts/generated-artifacts";
import { generate, LOCALES, parseGlossary, renderTable } from "./glossary-gen";

const fill = (value: string): Record<string, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, value]));

const glossary = parseGlossary(
  JSON.stringify({
    verbs: [{ id: "save", en: "Save", translations: fill("S") }],
    legalConcepts: [{ id: "matter", en: "Matter", translations: fill("M") }],
    ptBR: [{ en: "Matter", "pt-BR": "Caso", note: "note" }],
  }),
);

const blankDoc = [
  "<!-- glossary-gen:verbs-slavic-baltic start -->",
  "<!-- glossary-gen:verbs-slavic-baltic end -->",
  "<!-- glossary-gen:verbs-romance start -->",
  "<!-- glossary-gen:verbs-romance end -->",
  "<!-- glossary-gen:legal-slavic-baltic start -->",
  "<!-- glossary-gen:legal-slavic-baltic end -->",
  "<!-- glossary-gen:legal-romance start -->",
  "<!-- glossary-gen:legal-romance end -->",
  "<!-- glossary-gen:verbs-arabic start -->",
  "<!-- glossary-gen:verbs-arabic end -->",
  "<!-- glossary-gen:legal-arabic start -->",
  "<!-- glossary-gen:legal-arabic end -->",
  "<!-- glossary-gen:ptbr-special start -->",
  "<!-- glossary-gen:ptbr-special end -->",
  "",
].join("\n");

describe("renderTable", () => {
  test("pads each column to its widest cell", () => {
    expect(
      renderTable(
        ["A", "Long header"],
        [
          ["x", "y"],
          ["longcell", "z"],
        ],
      ),
    ).toBe(
      [
        "| A        | Long header |",
        "| -------- | ----------- |",
        "| x        | y           |",
        "| longcell | z           |",
      ].join("\n"),
    );
  });

  test("counts a diacritic as one column, not its UTF-8 byte length", () => {
    // "Uložiť" is six code points; the column pads to six, not nine bytes.
    expect(renderTable(["X"], [["Uložiť"], ["a"]])).toBe(
      ["| X      |", "| ------ |", "| Uložiť |", "| a      |"].join("\n"),
    );
  });
});

describe("generate", () => {
  test("fills every marked region with its table", () => {
    const result = generate(blankDoc, glossary);
    expect(result).toContain("| **Save** |");
    expect(result).toContain("Brazilian Portuguese");
    expect(result).toContain("| **Matter** |");
    expect(result).toContain("| English | pt-BR | Notes |");
    expect(result).toContain("Arabic");
  });

  test("repeating table generation leaves its intermediate output unchanged", () => {
    const once = generate(blankDoc, glossary);
    expect(generate(once, glossary)).toBe(once);
  });

  test("throws when a region marker is missing", () => {
    expect(() => generate("no markers here", glossary)).toThrow(
      /missing the `verbs-slavic-baltic` markers/u,
    );
  });
});

describe("parseGlossary", () => {
  test("rejects a term missing a locale", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [{ id: "save", en: "Save", translations: { cs: "Uložit" } }],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/missing translation for/u);
  });

  test("rejects a non-object forbidden block", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [
            {
              id: "save",
              en: "Save",
              forbidden: ["x"],
              translations: fill("S"),
            },
          ],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/must be an object keyed by locale/u);
  });

  test("rejects an unknown locale", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [
            { id: "save", en: "Save", translations: { ...fill("S"), xx: "S" } },
          ],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/unknown locale "xx"/u);
  });

  test("rejects a non-array forbidden list", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [
            {
              id: "save",
              en: "Save",
              forbidden: { fr: "Tribunal" },
              translations: fill("S"),
            },
          ],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/must be an array of strings/u);
  });

  test("rejects an unknown locale in forbidden", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [
            {
              id: "save",
              en: "Save",
              forbidden: { xx: ["Foo"] },
              translations: fill("S"),
            },
          ],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/unknown locale "xx" in/u);
  });
});

test("the real CLI writes canonical Arabic tables that pass its check without changing prose", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossary-cli-"));
  try {
    const document = `# Terminology\n\nIntroductory prose remains intact.\n\n${blankDoc}\nClosing prose remains intact.\n`;
    const input = JSON.stringify({
      verbs: [
        {
          id: "close",
          en: "Close",
          translations: { ...fill("Close"), ar: "إغلاق" },
        },
      ],
      legalConcepts: [
        {
          id: "case-law",
          en: "Case law",
          translations: { ...fill("Case law"), ar: "الاجتهاد القضائي" },
        },
      ],
      ptBR: [],
    });
    const terminology = path.join(directory, "TERMINOLOGY.md");
    await Bun.write(path.join(directory, "glossary.json"), input);
    await Bun.write(terminology, document);

    // The fixture reaches the width mismatch before testing the final output.
    const intermediate = generate(document, parseGlossary(input));
    expect(await formattedLikeRepository(intermediate, "md")).not.toBe(
      intermediate,
    );

    const runCli = async (flags: string[]) => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "glossary-gen.ts"),
          directory,
          ...flags,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { status, stdout, stderr };
    };
    const written = await runCli([]);
    expect(written.stderr).toBe("");
    expect(written.status).toBe(0);
    expect(written.stdout).toContain("Generated");
    const emitted = await Bun.file(terminology).text();
    expect(emitted).toBe(await formattedLikeRepository(emitted, "md"));
    expect(emitted).toContain("إغلاق");
    expect(emitted).toContain("الاجتهاد القضائي");
    expect(emitted).toContain("**Close**");
    expect(emitted).toContain("**Case law**");
    expect(emitted).toContain("Introductory prose remains intact.");
    expect(emitted).toContain("Closing prose remains intact.");
    const checked = await runCli(["--check"]);
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain("is in sync (2 terms)");
    expect(await Bun.file(terminology).text()).toBe(emitted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
