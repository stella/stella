import { describe, expect, test } from "bun:test";

import { LOCALES, parseGlossary } from "./glossary-gen";
import { buildBriefItems, renderBrief, selectBriefKeys } from "./i18n-brief";
import { emptyBaseline } from "./i18n-check";
import type { NestedMessages } from "./i18n-check";

const fill = (value: string): Record<string, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, value]));

const glossary = parseGlossary(
  JSON.stringify({
    verbs: [],
    legalConcepts: [
      {
        id: "matter",
        en: "Matter",
        note: "A client engagement. Long rationale follows.",
        forbidden: { cs: ["kauza"] },
        translations: { ...fill("x"), cs: "věc" },
      },
    ],
    ptBR: [],
  }),
);

const source: NestedMessages = {
  matters: {
    count: "{count, plural, one {# matter} other {# matters}}",
    open: "Open <link>{name}</link>",
    title: "Matters",
  },
  nav: { knowledge: "Intelligence" },
};
const target: NestedMessages = {
  matters: {
    count: "{count, plural, one {# věc} other {# věcí}}",
    open: "Open <link>{name}</link>",
    title: "Věci",
  },
  nav: { knowledge: "Znalosti" },
};
const lock = new Map([
  ["matters.count", "{count, plural, one {# matter} other {# matters}}"],
  ["matters.open", "Open <link>{name}</link>"],
  ["matters.title", "Matters"],
  ["nav.knowledge", "Knowledge"],
]);

describe("translation brief", () => {
  test("lists what i18n-check fails on for the locale, in catalog order", () => {
    expect(
      selectBriefKeys({
        source,
        target,
        locale: "cs",
        baseline: emptyBaseline(),
        lock,
      }),
    ).toEqual(["matters.open", "nav.knowledge"]);
    expect(
      selectBriefKeys({
        source,
        target,
        locale: "cs",
        baseline: {
          ...emptyBaseline(),
          identicalToSource: { "matters.open": ["cs"] },
        },
        lock,
      }),
    ).toEqual(["nav.knowledge"]);
  });

  test("gives each message the context a translator needs", () => {
    const [count, open, knowledge] = buildBriefItems({
      keys: ["matters.count", "matters.open", "nav.knowledge"],
      source,
      target,
      locale: "cs",
      lock,
      glossary,
      files: [{ path: "nav.tsx", text: 'const label = t("nav.knowledge");' }],
    });

    expect(count).toMatchObject({
      lockedSource: null,
      translation: "{count, plural, one {# věc} other {# věcí}}",
      placeholders: ["count"],
      missingPluralCategories: ["count#few"],
    });
    expect(count?.terms.map(({ id }) => id)).toEqual(["matter"]);
    expect(open).toMatchObject({
      translation: null,
      placeholders: ["<link>", "name"],
    });
    expect(knowledge).toMatchObject({
      lockedSource: "Knowledge",
      translation: "Znalosti",
      usages: [
        { path: "nav.tsx", line: 1, code: 'const label = t("nav.knowledge");' },
      ],
    });
  });

  test("asks to accept only the keys whose English changed", () => {
    const items = buildBriefItems({
      keys: ["matters.title", "nav.knowledge"],
      source,
      target,
      locale: "cs",
      lock,
      glossary,
      files: [],
    });
    const brief = renderBrief({
      locale: "cs",
      localeFile: "langs/cs.json",
      items,
    });

    expect(brief).toStartWith("# Translate 2 messages from en into cs (Czech)");
    expect(brief).toContain(
      '- Glossary: "Matter" → "věc"; never "kauza"; A client engagement.',
    );
    expect(brief).not.toContain("Long rationale");
    expect(brief).toContain("`bun run i18n:accept nav.knowledge`");
    expect(brief).not.toContain("i18n:accept matters.title");
    expect(
      renderBrief({ locale: "cs", localeFile: "cs.json", items: [] }),
    ).toBe("# Nothing to translate into cs (Czech)\n");
  });
});
