import { expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import ar from "@/i18n/langs/ar.json";
import cs from "@/i18n/langs/cs.json";
import de from "@/i18n/langs/de.json";
import en from "@/i18n/langs/en.json";
import es from "@/i18n/langs/es.json";
import et from "@/i18n/langs/et.json";
import fr from "@/i18n/langs/fr.json";
import hu from "@/i18n/langs/hu.json";
import lt from "@/i18n/langs/lt.json";
import lv from "@/i18n/langs/lv.json";
import pl from "@/i18n/langs/pl.json";
import ptBR from "@/i18n/langs/pt-BR.json";
import sk from "@/i18n/langs/sk.json";
import { formatListWithMore } from "@/i18n/list-format";

test("list composition owns the conjunction", () => {
  const result = formatListWithMore({
    items: ["a", "b"],
    additionalCount: 15,
    formatList: (items) => new Intl.ListFormat("en").format(items),
    formatMore: (count) => `${count} more`,
  });

  expect(result).toBe("a, b, and 15 more");
  expect(result).not.toContain("and and");
});

const catalogues = [
  { locale: "ar", messages: ar },
  { locale: "cs", messages: cs },
  { locale: "de", messages: de },
  { locale: "en", messages: en },
  { locale: "es", messages: es },
  { locale: "et", messages: et },
  { locale: "fr", messages: fr },
  { locale: "hu", messages: hu },
  { locale: "lt", messages: lt },
  { locale: "lv", messages: lv },
  { locale: "pl", messages: pl },
  { locale: "pt-BR", messages: ptBR },
  { locale: "sk", messages: sk },
] as const;

test("translated count fragments preserve every locale plural branch", () => {
  for (const { locale, messages } of catalogues) {
    const source = messages.chat.historyContext.unnamed;
    const branches = new Map(
      [
        ...source.matchAll(/(zero|one|two|few|many|other)\s*\{([^{}]*)\}/gu),
      ].map(([, category, text]) => [category, text]),
    );
    const pluralRules = new Intl.PluralRules(locale);
    const categoryCandidates = [
      ...Array.from({ length: 201 }, (_, count) => count),
      0.1,
      1.1,
      2.1,
      1_000_000,
    ];
    const requiredCounts = new Set([1, 2, 5, 21]);
    for (const count of requiredCounts) {
      expect(branches.has(pluralRules.select(count))).toBeTrue();
    }
    expect(branches.has("other")).toBeTrue();

    for (const category of branches.keys()) {
      const exemplar = categoryCandidates.find(
        (count) => pluralRules.select(count) === category,
      );
      expect(exemplar).toBeDefined();
      if (exemplar !== undefined) {
        requiredCounts.add(exemplar);
      }
    }

    const translate = createTranslator({ locale, messages });
    const formatNumber = new Intl.NumberFormat(locale);
    const formatList = new Intl.ListFormat(locale);
    const conjunction = formatList
      .formatToParts(["first", "second"])
      .findLast(({ type }) => type === "literal")?.value;
    expect(conjunction).toBeDefined();
    if (conjunction === undefined) {
      continue;
    }

    for (const count of requiredCounts) {
      const category = pluralRules.select(count);
      const branch = branches.get(category);
      expect(branch).toBeDefined();
      if (branch === undefined) {
        continue;
      }

      const more = translate("chat.historyContext.unnamed", { count });
      expect(more).toBe(branch.replace("#", () => formatNumber.format(count)));
      expect(more).not.toStartWith(conjunction.trim());

      if (count === 0) {
        continue;
      }

      const result = formatListWithMore({
        items: ["first"],
        additionalCount: count,
        formatList: (items) => formatList.format(items),
        formatMore: (additionalCount) =>
          translate("chat.historyContext.unnamed", {
            count: additionalCount,
          }),
      });
      expect(result).toBe(formatList.format(["first", more]));
      expect(
        formatList
          .formatToParts(["first", more])
          .filter(({ type }) => type === "literal"),
      ).toHaveLength(1);
    }
  }
});
