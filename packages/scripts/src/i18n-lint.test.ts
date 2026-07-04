import { describe, expect, test } from "bun:test";
import path from "node:path";

import { LOCALES, parseGlossary } from "./glossary-gen";
import {
  buildForbiddenRules,
  findDroppedExactSelectors,
  findDroppedPlurals,
  findForbiddenTerms,
  findIcuError,
  findMissingPluralCategories,
  findPlaceholderMismatch,
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
      isSuppressed(baseline, "placeholder", "a.b", "cs", {
        source: "Open {x}",
        target: "Otevřít",
      }),
    ).toBe(true);
  });

  test("re-checks when the translation is edited", () => {
    expect(
      isSuppressed(baseline, "placeholder", "a.b", "cs", {
        source: "Open {x}",
        target: "Edited",
      }),
    ).toBe(false);
  });

  test("re-checks when the en source changes under a stale translation", () => {
    expect(
      isSuppressed(baseline, "placeholder", "a.b", "cs", {
        source: "Open {x} and {y}",
        target: "Otevřít",
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
      findForbiddenTerms("Open this matter", "Diese Sache öffnen", "de", rules),
    ).toEqual(["Sache"]);
  });

  test("does not fire when the source is unrelated to the concept", () => {
    expect(
      findForbiddenTerms("A factual question", "Eine reine Sache", "de", rules),
    ).toEqual([]);
  });

  test("matches whole words only (no substring false positives)", () => {
    expect(
      findForbiddenTerms("Open this matter", "Sachenrecht gilt", "de", rules),
    ).toEqual([]);
  });

  test("detects the concept when the source uses the plural trigger", () => {
    // "matters" (plural) still triggers the "Matter" concept.
    expect(
      findForbiddenTerms(
        "Manage your matters",
        "Diese Sache öffnen",
        "de",
        rules,
      ),
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
      findForbiddenTerms("Open this matter", "افتح قضية", "ar", arRules),
    ).toEqual(["قضية"]);
    expect(
      findForbiddenTerms("Open this matter", "افتح القضية", "ar", arRules),
    ).toEqual(["قضية"]);
    expect(
      findForbiddenTerms("Open this matter", "والقضية مفتوحة", "ar", arRules),
    ).toEqual(["قضية"]);
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
      findForbiddenTerms(
        "Everyone in the organisation",
        "Alle in der Organisation",
        "de",
        rules,
        "knowledge.skills.form.scopeTeam",
      ),
    ).toEqual(["Organisation"]);
  });

  test("forbiddenOnKey fires on the word trigger when the source is not exempt", () => {
    // Source says "team member" (no "organiz-"); a target rendering it as an
    // organization member is caught even on a non-scope key.
    expect(
      findForbiddenTerms(
        "Choose an existing team member",
        "Ein Organisation hinzufügen",
        "de",
        rules,
        "workspaces.members.addMemberDescription",
      ),
    ).toEqual(["Organisation"]);
  });

  test("sourceExempt suppresses word-trigger enforcement of forbiddenOnKey", () => {
    // Source also says "organize", so a Slavic/German org form renders that
    // word, not the team concept: not flagged on a non-scope key.
    expect(
      findForbiddenTerms(
        "Organize team activity",
        "Alle in der Organisation",
        "de",
        rules,
        "workspaces.emptyMatters.description",
      ),
    ).toEqual([]);
  });

  test("key trigger ignores sourceExempt (scope labels are always strict)", () => {
    expect(
      findForbiddenTerms(
        "Organize the team",
        "Alle in der Organisation",
        "de",
        rules,
        "knowledge.agentSkills.scopeTeam",
      ),
    ).toEqual(["Organisation"]);
  });

  test("forbidden (firm) words are enforced broadly via the word trigger", () => {
    expect(
      findForbiddenTerms(
        "team-wide list",
        "kanzleiweite Kanzlei",
        "de",
        rules,
        "settings.anonymization.description",
      ),
    ).toEqual(["Kanzlei"]);
  });

  test("English self-check flags banned source wording on a key-trigger key", () => {
    expect(
      findForbiddenTerms(
        "Everyone in the organisation",
        "Everyone in the organisation",
        "en",
        rules,
        "knowledge.agentSkills.scopeTeam",
      ),
    ).toEqual(["organisation"]);
  });

  test("no key and no word trigger means no enforcement", () => {
    expect(
      findForbiddenTerms(
        "Configure your organisation",
        "Alle in der Organisation",
        "de",
        rules,
        "consent.scopeOnboarding",
      ),
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
        findForbiddenTerms(regressed, regressed, "en", realRules, key),
      ).not.toEqual([]);
    });
  }

  test("a target-locale org regression is caught on the member key", () => {
    // de "Organisationsmitglied" reintroduced where Team wording is required.
    expect(
      findForbiddenTerms(
        "Choose an existing team member to add to this matter",
        "Ein bestehendes Organisationsmitglied zu dieser Akte hinzufügen",
        "de",
        realRules,
        "workspaces.members.addMemberDescription",
      ),
    ).not.toEqual([]);
  });

  test("genuinely org-scoped keys are not flagged (no over-broadening)", () => {
    // settings.organization.renameTitle is legitimately about the org entity;
    // its source has no "team" word and its path is not a Team-scope trigger.
    expect(
      findForbiddenTerms(
        "Rename organization",
        "Rename organization",
        "en",
        realRules,
        "settings.organization.renameTitle",
      ),
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
        findForbiddenTerms(
          "Loading",
          value,
          locale,
          realRules,
          "common.loading",
        ),
      ).toEqual([value]);
    });
  }
});
