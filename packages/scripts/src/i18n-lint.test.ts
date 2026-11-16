import { describe, expect, test } from "bun:test";
import path from "node:path";

import { LOCALES, parseGlossary } from "./glossary-gen";
import { isPlainRecord } from "./i18n-check";
import {
  buildForbiddenRules,
  findBareErrors,
  findDroppedExactSelectors,
  findDroppedPlurals,
  findForbiddenGuidance,
  findForbiddenTerms,
  findIcuError,
  findInternalIdArguments,
  findMissingPluralCategories,
  findPlaceholderMismatch,
  hasEmDash,
  hasInvalidCapitalizedStella,
  isBareErrorMessage,
  isSuppressed,
} from "./i18n-lint";
import type { LintBaseline } from "./i18n-lint";

describe("findPlaceholderMismatch", () => {
  test("returns null when the variable sets match (order is irrelevant)", () => {
    expect(
      findPlaceholderMismatch("Hi {name}, {count}", "{count} – {name}"),
    ).toBeNull();
  });

  test("flags a dropped variable", () => {
    expect(findPlaceholderMismatch("Sent to {email}", "Odesláno")).toEqual({
      missing: ["email"],
      extra: [],
    });
  });

  test("flags a renamed variable as both missing and extra", () => {
    expect(findPlaceholderMismatch("{a}", "{b}")).toEqual({
      missing: ["a"],
      extra: ["b"],
    });
  });

  test("tracks rich-text tag names (t.rich), not just their children", () => {
    expect(
      findPlaceholderMismatch("<terms>Terms</terms>", "<link>Podmínky</link>"),
    ).toEqual({ missing: ["<terms>"], extra: ["<link>"] });
  });

  test("counts the plural argument, not the # placeholder", () => {
    expect(
      findPlaceholderMismatch(
        "{count, plural, one {# item} other {# items}}",
        "{count, plural, one {# položka} few {# položky} other {# položek}}",
      ),
    ).toBeNull();
  });
});

describe("stella wordmark casing", () => {
  test("allows sentence starts but rejects capitalized mid-sentence forms", () => {
    const midSentence = ["Ask", "Stella to review the document"].join(" ");
    const declinedMidSentence = ["Nurodykite", "Stellai, ko ieškoti"].join(" ");
    expect(hasInvalidCapitalizedStella("Stella reviews the document")).toBe(
      false,
    );
    expect(
      hasInvalidCapitalizedStella("Ready. Stella reviews the document"),
    ).toBe(false);
    expect(hasInvalidCapitalizedStella(midSentence)).toBe(true);
    expect(hasInvalidCapitalizedStella(declinedMidSentence)).toBe(true);
    expect(hasInvalidCapitalizedStella("stella reviews the document")).toBe(
      false,
    );
  });
});

describe("em dash in catalogue copy", () => {
  test("rejects the em dash and allows other punctuation and ranges", () => {
    expect(hasEmDash("Saved \u2014 just now")).toBe(true);
    expect(hasEmDash("Uloženo \u2014 právě teď")).toBe(true);
    expect(hasEmDash("Saved: just now")).toBe(false);
    expect(hasEmDash("Pages 2–4")).toBe(false);
    expect(hasEmDash("Uloženo – právě teď")).toBe(false);
    expect(hasEmDash("Draft (not sent)")).toBe(false);
    expect(hasEmDash("\u2014")).toBe(false);
    expect(hasEmDash(" \u2014 ")).toBe(true);
  });
});

describe("findInternalIdArguments", () => {
  test("flags an argument that names a storage handle", () => {
    expect(findInternalIdArguments("Replace {blockId}")).toEqual(["blockId"]);
    expect(
      findInternalIdArguments(
        "{count, plural, one {# edit in {paraId}} other {# edits in {commentIds}}}",
      ),
    ).toEqual(["commentIds", "paraId"]);
  });

  test("accepts arguments that describe what the reader knows", () => {
    expect(
      findInternalIdArguments("Replace “{find}” with “{replace}”"),
    ).toEqual([]);
    expect(
      findInternalIdArguments(
        "{label, select, none {Rewrite a paragraph} other {Rewrite paragraph {label}}}",
      ),
    ).toEqual([]);
    expect(findInternalIdArguments("Paid {amount} on {valid}")).toEqual([]);
  });
});

describe("findIcuError", () => {
  test("returns null for valid ICU", () => {
    expect(findIcuError("{count, plural, one {#} other {#}}")).toBeNull();
  });

  test("returns a message for broken ICU", () => {
    expect(findIcuError("{count, plural, one {#}")).not.toBeNull();
  });
});

describe("findMissingPluralCategories", () => {
  test("flags Polish missing few/many for an English-shaped plural", () => {
    expect(
      findMissingPluralCategories("{n, plural, one {#} other {#}}", "pl"),
    ).toEqual(expect.arrayContaining(["n#few", "n#many"]));
  });

  test("passes when the locale needs only the present categories", () => {
    expect(
      findMissingPluralCategories("{n, plural, one {#} other {#}}", "de"),
    ).toEqual([]);
  });

  test("does not require cs/sk fractional-only `many` for integer UI counts", () => {
    expect(
      findMissingPluralCategories(
        "{n, plural, one {#} few {#} other {#}}",
        "cs",
      ),
    ).toEqual([]);
  });

  test("does not require the dormant es/fr/pt-BR `many` (exact millions)", () => {
    for (const locale of ["es", "fr", "pt-BR"]) {
      expect(
        findMissingPluralCategories("{n, plural, one {#} other {#}}", locale),
      ).toEqual([]);
    }
  });

  test("does not count exact selectors like =0 toward CLDR categories", () => {
    expect(
      findMissingPluralCategories(
        "{n, plural, =0 {none} one {#} other {#}}",
        "en",
      ),
    ).toEqual([]);
  });

  test("degrades to [] for an invalid locale code instead of throwing", () => {
    expect(
      findMissingPluralCategories("{n, plural, one {#} other {#}}", "!"),
    ).toEqual([]);
  });
});

describe("findDroppedPlurals", () => {
  test("flags a source plural flattened to plain interpolation", () => {
    expect(
      findDroppedPlurals("{count, plural, one {#} other {#}}", "{count} items"),
    ).toEqual(["count"]);
  });

  test("passes when the target keeps the plural", () => {
    expect(
      findDroppedPlurals(
        "{count, plural, one {#} other {#}}",
        "{count, plural, one {#} few {#} other {#}}",
      ),
    ).toEqual([]);
  });

  test("flags a plural that dropped the count from every branch", () => {
    expect(
      findDroppedPlurals(
        "{count, plural, one {# file} other {# files}}",
        "{count, plural, one {file} other {files}}",
      ),
    ).toEqual(["count"]);
  });

  test("allows one branch to omit the count when another shows it", () => {
    expect(
      findDroppedPlurals(
        "{count, plural, one {# file} other {# files}}",
        "{count, plural, one {jeden soubor} other {# souborů}}",
      ),
    ).toEqual([]);
  });

  test("does not count a nested plural's # as the outer count", () => {
    expect(
      findDroppedPlurals(
        "{count, plural, one {# file} other {# files}}",
        "{count, plural, one {{n, plural, other {#}}} other {{n, plural, other {#}}}}",
      ),
    ).toEqual(["count"]);
  });

  test("counts a {count, number} formatted node as showing the count", () => {
    expect(
      findDroppedPlurals(
        "{count, plural, one {# file} other {# files}}",
        "{count, plural, one {{count, number} soubor} other {{count, number} souborů}}",
      ),
    ).toEqual([]);
  });
});

describe("findDroppedExactSelectors", () => {
  test("flags a dropped source exact selector (=0 zero-state)", () => {
    expect(
      findDroppedExactSelectors(
        "{count, plural, =0 {No results} one {# result} other {# results}}",
        "{count, plural, one {# výsledek} few {# výsledky} other {# výsledků}}",
      ),
    ).toEqual(["count=0"]);
  });

  test("passes when the target keeps the source's exact selectors", () => {
    expect(
      findDroppedExactSelectors(
        "{count, plural, =0 {No results} other {# results}}",
        "{count, plural, =0 {Žádné} other {# výsledků}}",
      ),
    ).toEqual([]);
  });
});

describe("isSuppressed", () => {
  const baseline: LintBaseline = {
    placeholder: { "a.b": { cs: { source: "Open {x}", target: "Otevřít" } } },
    icu: {},
    plural: {},
    terminology: {},
  };

  test("suppresses only when both source and target are unchanged", () => {
    expect(
      isSuppressed({
        baseline,
        category: "placeholder",
        key: "a.b",
        locale: "cs",
        entry: {
          source: "Open {x}",
          target: "Otevřít",
        },
      }),
    ).toBe(true);
  });

  test("re-checks when the translation is edited", () => {
    expect(
      isSuppressed({
        baseline,
        category: "placeholder",
        key: "a.b",
        locale: "cs",
        entry: {
          source: "Open {x}",
          target: "Edited",
        },
      }),
    ).toBe(false);
  });

  test("re-checks when the en source changes under a stale translation", () => {
    expect(
      isSuppressed({
        baseline,
        category: "placeholder",
        key: "a.b",
        locale: "cs",
        entry: {
          source: "Open {x} and {y}",
          target: "Otevřít",
        },
      }),
    ).toBe(false);
  });
});

describe("terminology", () => {
  const fill = (value: string): Record<string, string> =>
    Object.fromEntries(LOCALES.map((locale) => [locale, value]));
  const rules = buildForbiddenRules(
    parseGlossary(
      JSON.stringify({
        verbs: [],
        legalConcepts: [
          {
            id: "matter",
            en: "Matter",
            forbidden: { de: ["Sache"] },
            translations: fill("x"),
          },
        ],
        ptBR: [],
      }),
    ),
  );

  test("flags a forbidden rendering when the source is about the concept", () => {
    expect(
      findForbiddenTerms({
        source: "Open this matter",
        target: "Diese Sache öffnen",
        locale: "de",
        rules,
      }),
    ).toEqual(["Sache"]);
  });

  test("does not fire when the source is unrelated to the concept", () => {
    expect(
      findForbiddenTerms({
        source: "A factual question",
        target: "Eine reine Sache",
        locale: "de",
        rules,
      }),
    ).toEqual([]);
  });

  test("matches whole words only (no substring false positives)", () => {
    expect(
      findForbiddenTerms({
        source: "Open this matter",
        target: "Sachenrecht gilt",
        locale: "de",
        rules,
      }),
    ).toEqual([]);
  });

  test("detects the concept when the source uses the plural trigger", () => {
    // "matters" (plural) still triggers the "Matter" concept.
    expect(
      findForbiddenTerms({
        source: "Manage your matters",
        target: "Diese Sache öffnen",
        locale: "de",
        rules,
      }),
    ).toEqual(["Sache"]);
  });

  test("matches an Arabic forbidden term carrying proclitics (ال/و prefixes)", () => {
    const arRules = buildForbiddenRules(
      parseGlossary(
        JSON.stringify({
          verbs: [],
          legalConcepts: [
            {
              id: "matter",
              en: "Matter",
              forbidden: { ar: ["قضية"] },
              translations: fill("x"),
            },
          ],
          ptBR: [],
        }),
      ),
    );
    // bare, ال-prefixed, and و+ال-prefixed forms all count.
    expect(
      findForbiddenTerms({
        source: "Open this matter",
        target: "افتح قضية",
        locale: "ar",
        rules: arRules,
      }),
    ).toEqual(["قضية"]);
    expect(
      findForbiddenTerms({
        source: "Open this matter",
        target: "افتح القضية",
        locale: "ar",
        rules: arRules,
      }),
    ).toEqual(["قضية"]);
    expect(
      findForbiddenTerms({
        source: "Open this matter",
        target: "والقضية مفتوحة",
        locale: "ar",
        rules: arRules,
      }),
    ).toEqual(["قضية"]);
  });
});

describe("terminology: keyExempt", () => {
  const fill = (value: string): Record<string, string> =>
    Object.fromEntries(LOCALES.map((locale) => [locale, value]));
  const rules = buildForbiddenRules(
    parseGlossary(
      JSON.stringify({
        verbs: [],
        legalConcepts: [
          {
            id: "template",
            en: "Template",
            forbidden: { cs: ["šablona"] },
            forbiddenAlways: { cs: ["šablonovač"] },
            keyExempt: ["documentProperties"],
            translations: fill("x"),
          },
        ],
        nouns: [],
        ptBR: [],
      }),
    ),
  );

  test("still flags the rendering on a key outside the exemption", () => {
    expect(
      findForbiddenTerms({
        source: "Template",
        target: "Šablona",
        locale: "cs",
        rules,
        key: "templates.studio.heading",
      }),
    ).toEqual(["šablona"]);
  });

  test("allows the rendering on an exempt key", () => {
    expect(
      findForbiddenTerms({
        source: "Template",
        target: "Šablona",
        locale: "cs",
        rules,
        key: "inspector.metadata.documentProperties.keys.template",
      }),
    ).toEqual([]);
  });

  test("exempts the ungated bans too, since the whole concept is exempt", () => {
    expect(
      findForbiddenTerms({
        source: "Something else entirely",
        target: "Šablonovač",
        locale: "cs",
        rules,
        key: "inspector.metadata.documentProperties.keys.template",
      }),
    ).toEqual([]);
  });

  test("cannot exempt a check that passes no key", () => {
    // Source-only callers have no key to match, so the ban still applies:
    // an exemption must never widen into "off everywhere" by omission.
    expect(
      findForbiddenTerms({
        source: "Template",
        target: "Šablona",
        locale: "cs",
        rules,
      }),
    ).toEqual(["šablona"]);
  });
});

describe("terminology: forbiddenAlways", () => {
  const fill = (value: string): Record<string, string> =>
    Object.fromEntries(LOCALES.map((locale) => [locale, value]));
  const rules = buildForbiddenRules(
    parseGlossary(
      JSON.stringify({
        verbs: [],
        legalConcepts: [],
        nouns: [
          {
            id: "item",
            en: "Item",
            forbiddenAlways: { cs: ["entita", "entity"], en: ["entity"] },
            translations: fill("x"),
          },
        ],
        ptBR: [],
      }),
    ),
  );

  test("flags the rendering even when the source never names the concept", () => {
    // The point of an unconditional ban: reword the en source and the stale
    // translation must still be caught.
    expect(
      findForbiddenTerms({
        source: "This document has no fields to view",
        target: "Tato entita nemá žádná pole k zobrazení",
        locale: "cs",
        rules,
        key: "workspaces.noFields",
      }),
    ).toEqual(["entita"]);
  });

  test("flags the banned wording in the English source itself", () => {
    const source = "This entity has no fields to view";
    expect(
      findForbiddenTerms({
        source,
        target: source,
        locale: "en",
        rules,
      }),
    ).toEqual(["entity"]);
  });

  test("still matches whole words only", () => {
    expect(
      findForbiddenTerms({
        source: "Usage entitlement",
        target: "Nárok entitlement",
        locale: "cs",
        rules,
      }),
    ).toEqual([]);
  });
});

describe("terminology: catalogue copy quality", () => {
  const guidance =
    "Use direct, specific, professional language instead of placeholder, promotional, or playful copy.";
  const fill = (value: string): Record<string, string> =>
    Object.fromEntries(LOCALES.map((locale) => [locale, value]));
  const forbiddenAlways = Object.fromEntries(
    ["en", ...LOCALES].map((locale) => [
      locale,
      ["Lorem ipsum", "seamless", "Oops", "\\p{Emoji}"],
    ]),
  );
  const rules = buildForbiddenRules(
    parseGlossary(
      JSON.stringify({
        verbs: [],
        legalConcepts: [],
        nouns: [
          {
            id: "catalogue-copy-quality",
            en: "Catalogue copy quality",
            guidance,
            forbiddenAlways,
            translations: fill("x"),
          },
        ],
        ptBR: [],
      }),
    ),
  );

  test.each(["Lorem ipsum dolor sit amet", "A seamless workflow", "Oops!"])(
    "rejects filler copy: %s",
    (value) => {
      expect(
        findForbiddenTerms({
          source: value,
          target: value,
          locale: "en",
          rules,
        }),
      ).not.toEqual([]);
    },
  );

  test("rejects emoji code points in every locale", () => {
    expect(
      findForbiddenTerms({
        source: "Saved",
        target: "Uloženo ✅",
        locale: "cs",
        rules,
      }),
    ).toEqual(["\\p{Emoji}"]);
  });

  test("reports the expected replacement tone", () => {
    expect(
      findForbiddenGuidance({
        source: "Oops!",
        target: "Oops!",
        locale: "en",
        rules,
      }),
    ).toEqual([guidance]);
  });

  test("allows concrete copy and non-emoji symbols", () => {
    expect(
      findForbiddenTerms({
        source: "File saved",
        target: "Soubor uložen § 10",
        locale: "cs",
        rules,
      }),
    ).toEqual([]);
  });
});

describe("terminology: key triggers and forbiddenOnKey", () => {
  const fill = (value: string): Record<string, string> =>
    Object.fromEntries(LOCALES.map((locale) => [locale, value]));
  const rules = buildForbiddenRules(
    parseGlossary(
      JSON.stringify({
        verbs: [],
        legalConcepts: [
          {
            id: "team",
            en: "Team",
            // firm: broad (unconditional). org: key-trigger always, word-trigger
            // unless the source is about "organiz-ing".
            forbidden: { de: ["Kanzlei"], en: ["firm"] },
            forbiddenOnKey: { de: ["Organisation"], en: ["organisation"] },
            keyTriggers: ["scopeTeam"],
            sourceExempt: ["organiz", "organis"],
            translations: fill("x"),
          },
        ],
        ptBR: [],
      }),
    ),
  );

  test("key trigger fires the rule even when English lacks the trigger word", () => {
    expect(
      findForbiddenTerms({
        source: "Everyone in the organisation",
        target: "Alle in der Organisation",
        locale: "de",
        rules,
        key: "knowledge.skills.form.scopeTeam",
      }),
    ).toEqual(["Organisation"]);
  });

  test("forbiddenOnKey fires on the word trigger when the source is not exempt", () => {
    // Source says "team member" (no "organiz-"); a target rendering it as an
    // organization member is caught even on a non-scope key.
    expect(
      findForbiddenTerms({
        source: "Choose an existing team member",
        target: "Ein Organisation hinzufügen",
        locale: "de",
        rules,
        key: "workspaces.members.addMemberDescription",
      }),
    ).toEqual(["Organisation"]);
  });

  test("sourceExempt suppresses word-trigger enforcement of forbiddenOnKey", () => {
    // Source also says "organize", so a Slavic/German org form renders that
    // word, not the team concept: not flagged on a non-scope key.
    expect(
      findForbiddenTerms({
        source: "Organize team activity",
        target: "Alle in der Organisation",
        locale: "de",
        rules,
        key: "workspaces.emptyMatters.description",
      }),
    ).toEqual([]);
  });

  test("key trigger ignores sourceExempt (scope labels are always strict)", () => {
    expect(
      findForbiddenTerms({
        source: "Organize the team",
        target: "Alle in der Organisation",
        locale: "de",
        rules,
        key: "knowledge.agentSkills.scopeTeam",
      }),
    ).toEqual(["Organisation"]);
  });

  test("forbidden (firm) words are enforced broadly via the word trigger", () => {
    expect(
      findForbiddenTerms({
        source: "team-wide list",
        target: "kanzleiweite Kanzlei",
        locale: "de",
        rules,
        key: "settings.anonymization.description",
      }),
    ).toEqual(["Kanzlei"]);
  });

  test("English self-check flags banned source wording on a key-trigger key", () => {
    expect(
      findForbiddenTerms({
        source: "Everyone in the organisation",
        target: "Everyone in the organisation",
        locale: "en",
        rules,
        key: "knowledge.agentSkills.scopeTeam",
      }),
    ).toEqual(["organisation"]);
  });

  test("no key and no word trigger means no enforcement", () => {
    expect(
      findForbiddenTerms({
        source: "Configure your organisation",
        target: "Alle in der Organisation",
        locale: "de",
        rules,
        key: "consent.scopeOnboarding",
      }),
    ).toEqual([]);
  });
});

// Guards the real glossary's Team-scope keyTriggers: every key this PR migrated
// to Team wording must stay covered by a source-side trigger, so an English
// regression that drops the word "team" (and thus the word trigger) is still
// caught via the key path. Loads the shipped glossary, not a synthetic stub, so
// the test breaks if a future edit removes one of these keyTriggers.
const realGlossaryPath = path.resolve(
  import.meta.dir,
  "../../../apps/web/src/i18n/glossary.json",
);
const realRules = buildForbiddenRules(
  parseGlossary(await Bun.file(realGlossaryPath).text()),
);

describe("terminology: real glossary covers migrated Team-scope keys", () => {
  // Each migrated key, with its English source as shipped and a regression that
  // reintroduces org/firm wording while dropping the word "team" (so only the
  // key path, not the source word, can trigger the rule).
  const migrated = [
    {
      key: "settings.organization.anonymization.description",
      regressed:
        "Curate the firm-wide deny list of terms the anonymization pipeline always masks",
    },
    {
      key: "settings.organization.anonymization.entriesHeading",
      regressed: "Firm-wide terms ({count})",
    },
    {
      key: "onboarding.catalogueThirdPartyDisclaimer",
      regressed: "verifying it is compliant with your firm's policies",
    },
    {
      key: "knowledge.skills.form.scopeTeam",
      regressed: "Everyone in the organisation",
    },
    {
      key: "knowledge.agentSkills.scopeTeam",
      regressed: "Everyone in the organisation",
    },
  ];

  for (const { key, regressed } of migrated) {
    test(`English regression to org/firm wording is caught on ${key}`, () => {
      expect(
        findForbiddenTerms({
          source: regressed,
          target: regressed,
          locale: "en",
          rules: realRules,
          key,
        }),
      ).not.toEqual([]);
    });
  }

  test("a target-locale org regression is caught on the member key", () => {
    // de "Organisationsmitglied" reintroduced where Team wording is required.
    expect(
      findForbiddenTerms({
        source: "Choose an existing team member to add to this matter",
        target:
          "Ein bestehendes Organisationsmitglied zu dieser Akte hinzufügen",
        locale: "de",
        rules: realRules,
        key: "workspaces.members.addMemberDescription",
      }),
    ).not.toEqual([]);
  });

  test("genuinely org-scoped keys are not flagged (no over-broadening)", () => {
    // settings.organization.renameTitle is legitimately about the org entity;
    // its source has no "team" word and its path is not a Team-scope trigger.
    expect(
      findForbiddenTerms({
        source: "Rename organization",
        target: "Rename organization",
        locale: "en",
        rules: realRules,
        key: "settings.organization.renameTitle",
      }),
    ).toEqual([]);
  });

  const loadingRegressions = [
    { locale: "en", value: "Analyzing..." },
    { locale: "ar", value: "جارٍ التحليل..." },
    { locale: "cs", value: "Analyzování..." },
    { locale: "sk", value: "Analyzovanie..." },
    { locale: "pl", value: "Analizowanie..." },
    { locale: "de", value: "Analyse..." },
    { locale: "et", value: "Analüüsimine..." },
    { locale: "hu", value: "Elemzés..." },
    { locale: "lt", value: "Analizuojama..." },
    { locale: "lv", value: "Analizē..." },
    { locale: "es", value: "Analizando..." },
    { locale: "fr", value: "Analyse..." },
    { locale: "pt-BR", value: "Analisando..." },
  ];

  for (const { locale, value } of loadingRegressions) {
    test(`${locale} standalone Loading cannot regress to analysis copy`, () => {
      expect(
        findForbiddenTerms({
          source: "Loading",
          target: value,
          locale,
          rules: realRules,
          key: "common.loading",
        }),
      ).toEqual([value]);
    });
  }
});

describe("terminology: Matter stays canonical in search", () => {
  test("the search kind remains protected if its English source is reworded", () => {
    expect(
      findForbiddenTerms({
        source: "Client work",
        target: "Věc",
        locale: "cs",
        rules: realRules,
        key: "search.kinds.matter",
      }),
    ).toEqual(["Věc"]);
  });

  test("Czech case-law uses of věc remain outside the Matter concept", () => {
    expect(
      findForbiddenTerms({
        source: "No case was found for this court and case number.",
        target: "Pro tento soud a sp. zn. nebyla nalezena věc.",
        locale: "cs",
        rules: realRules,
        key: "workspaces.infosoud.notFound",
      }),
    ).toEqual([]);
  });

  test("every locale derives the search kind from the canonical Matter term", async () => {
    const glossary = parseGlossary(await Bun.file(realGlossaryPath).text());
    const matter = glossary.legalConcepts.find(({ id }) => id === "matter");
    expect(matter).toBeDefined();

    const englishCatalogue = await Bun.file(
      path.resolve(import.meta.dir, "../../../apps/web/src/i18n/langs/en.json"),
    ).json();
    expect(englishCatalogue.search.kinds.matter).toBe(matter?.en);

    for (const locale of LOCALES) {
      const catalogue = await Bun.file(
        path.resolve(
          import.meta.dir,
          `../../../apps/web/src/i18n/langs/${locale}.json`,
        ),
      ).json();
      expect(catalogue.search.kinds.matter).toBe(matter?.translations[locale]);
    }
  });
});

describe("terminology: matter transfers", () => {
  test("declined matter synonyms are rejected even when English only names placeholders", () => {
    const source =
      "{fileName} belongs to {sourceMatterName}. Copy it into {matterName}.";
    for (const [locale, term] of [
      ["cs", "případ"],
      ["cs", "případu"],
      ["cs", "případem"],
      ["sk", "prípadu"],
      ["sk", "prípadoch"],
      ["de", "Angelegenheit"],
      ["et", "asja"],
    ] as const) {
      expect(
        findForbiddenTerms({
          source,
          target: term,
          locale,
          rules: realRules,
          key: "inspector.groups.fileMoveDescription",
        }),
      ).toContain(term);
    }
  });

  test("ordinary in-case idioms outside matter copy remain valid", () => {
    expect(
      findForbiddenTerms({
        source: "In case of an error",
        target: "V případě chyby",
        locale: "cs",
        rules: realRules,
        key: "errors.example",
      }),
    ).toEqual([]);
    expect(
      findForbiddenTerms({
        source: "In case of an error",
        target: "V prípade chyby",
        locale: "sk",
        rules: realRules,
        key: "errors.example",
      }),
    ).toEqual([]);
  });
});

describe("bare error messages", () => {
  test("a message that only says something failed is bare", () => {
    for (const message of [
      "Error",
      "Error:",
      "error.",
      "Something went  wrong",
      "An unexpected error occurred!",
      "Oops\u2026",
      "Action failed",
    ]) {
      expect(isBareErrorMessage(message)).toBe(true);
    }
  });

  test("a message that says what failed or what to do is not bare", () => {
    for (const message of [
      "Something went wrong. Try again, or reload the page if it keeps happening.",
      "Something went wrong. Please try again.",
      "Recent activity could not be loaded.",
      "Failed",
    ]) {
      expect(isBareErrorMessage(message)).toBe(false);
    }
  });

  test("reports the keys of bare messages", () => {
    expect(
      findBareErrors({
        "common.somethingWentWrong":
          "Something went wrong. Try again, or reload the page if it keeps happening.",
        "billing.saveFailed": "Something went wrong",
        "common.error": "Error",
      }),
    ).toEqual(["billing.saveFailed", "common.error"]);
  });

  test("the MCP app catalog has no bare message", async () => {
    const catalogPath = path.resolve(
      import.meta.dir,
      "../../api-contract/src/mcp-app-messages.json",
    );
    const catalog: unknown = JSON.parse(await Bun.file(catalogPath).text());
    const en = isPlainRecord(catalog) ? catalog["en"] : undefined;
    if (!isPlainRecord(en)) {
      throw new Error(`${catalogPath} has no en messages`);
    }
    expect(
      Object.entries(en)
        .filter(
          ([, value]) => typeof value === "string" && isBareErrorMessage(value),
        )
        .map(([key]) => key),
    ).toEqual([]);
  });
});
