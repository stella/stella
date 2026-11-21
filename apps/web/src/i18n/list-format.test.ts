import { expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { UI_LOCALES } from "@stll/locales";

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

type Messages = { chat: { historyContext: { unnamed: string } } };

const messageAt = (messages: unknown, key: string): unknown => {
  let value = messages;
  for (const segment of key.split(".")) {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    value = new Map(Object.entries(value)).get(segment);
  }
  return value;
};

const isMessages = (value: unknown): value is Messages =>
  typeof messageAt(value, "chat.historyContext.unnamed") === "string";

test("translated count fragments preserve every locale plural branch", async () => {
  for (const locale of UI_LOCALES) {
    const parsed: unknown = await Bun.file(
      new URL(`langs/${locale}.json`, import.meta.url),
    ).json();
    expect(isMessages(parsed)).toBeTrue();
    if (!isMessages(parsed)) {
      continue;
    }
    const messages = parsed;
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
