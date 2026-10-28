import { expect, test } from "bun:test";

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

test("a translated count fragment cannot pre-join the formatter conjunction", () => {
  const conjunctions = /^(?:and|a|und|y|ja|et|és|ir|un|i|e)\b/iu;
  for (const messages of [
    ar,
    cs,
    de,
    en,
    es,
    et,
    fr,
    hu,
    lt,
    lv,
    pl,
    ptBR,
    sk,
  ]) {
    const more = (messages as { chat: { historyContext: { unnamed: string } } })
      .chat.historyContext.unnamed;
    expect(more).not.toMatch(conjunctions);
  }
});
