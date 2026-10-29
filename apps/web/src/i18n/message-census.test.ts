import {
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  type MessageFormatElement,
  parse,
  type PluralElement,
  TYPE,
} from "@formatjs/icu-messageformat-parser";
import { expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

type Catalog = Record<string, unknown>;
type Message = { key: string; value: string };
type Exemption = {
  check: "formatting";
  key: string;
  locale: string;
  reason: string;
};

// Keep exceptions reviewable: every entry must name one message, locale, and reason.
const EXEMPTIONS: readonly Exemption[] = [];

const flattenMessages = (catalog: unknown, prefix = ""): Message[] => {
  const messages: Message[] = [];
  if (typeof catalog !== "object" || catalog === null) {
    return messages;
  }
  for (const [name, value] of Object.entries(catalog)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string") {
      messages.push({ key, value });
    } else if (typeof value === "object" && value !== null) {
      messages.push(...flattenMessages(value, key));
    }
  }
  return messages;
};

type Analysis = {
  arguments: Set<string>;
  numericArguments: Set<string>;
  dateArguments: Set<string>;
  plurals: PluralElement[];
  tags: Set<string>;
};

export const analyzeMessage = (message: string): Analysis => {
  const analysis: Analysis = {
    arguments: new Set(),
    numericArguments: new Set(),
    dateArguments: new Set(),
    plurals: [],
    tags: new Set(),
  };
  const plainArguments = new Set<string>();

  const visit = (elements: MessageFormatElement[], pluralStack: string[]) => {
    for (const element of elements) {
      if (
        isArgumentElement(element) ||
        isNumberElement(element) ||
        isDateElement(element) ||
        isTimeElement(element) ||
        isSelectElement(element) ||
        isPluralElement(element)
      ) {
        analysis.arguments.add(element.value);
      }
      if (isArgumentElement(element)) {
        plainArguments.add(element.value);
      } else if (isNumberElement(element)) {
        analysis.numericArguments.add(element.value);
      }
      if (isDateElement(element) || isTimeElement(element)) {
        analysis.dateArguments.add(element.value);
      }
      if (isTagElement(element)) {
        analysis.tags.add(element.value);
        visit(element.children, pluralStack);
      } else if (isSelectElement(element)) {
        for (const option of Object.values(element.options)) {
          visit(option.value, pluralStack);
        }
      } else if (isPluralElement(element)) {
        analysis.plurals.push(element);
        for (const option of Object.values(element.options)) {
          visit(option.value, [...pluralStack, element.value]);
        }
      } else if (element.type === TYPE.pound) {
        const owner = pluralStack.at(-1);
        if (owner !== undefined) {
          analysis.numericArguments.add(owner);
        }
      }
    }
  };

  visit(parse(message, { captureLocation: true }), []);
  if (analysis.numericArguments.size > 0) {
    for (const argument of plainArguments) {
      analysis.numericArguments.add(argument);
    }
  }
  return analysis;
};

const sorted = (values: Iterable<string>) => [...values].toSorted();

export const censusErrors = (
  source: string,
  translation: string,
  locale: string,
): string[] => {
  const sourceAnalysis = analyzeMessage(source);
  const translationAnalysis = analyzeMessage(translation);
  const errors: string[] = [];

  if (
    JSON.stringify(sorted(sourceAnalysis.arguments)) !==
    JSON.stringify(sorted(translationAnalysis.arguments))
  ) {
    errors.push(
      `arguments: expected ${sorted(sourceAnalysis.arguments).join(", ")}; received ${sorted(translationAnalysis.arguments).join(", ")}`,
    );
  }

  const categories = new Intl.PluralRules(locale).resolvedOptions()
    .pluralCategories;
  if (categories.length > 1) {
    for (const [index, plural] of translationAnalysis.plurals.entries()) {
      const missing = categories.filter(
        (category) => !(category in plural.options),
      );
      if (missing.length > 0) {
        errors.push(
          `plural ${index + 1} (${plural.value}) is missing ${missing.join(", ")}`,
        );
      }
    }
  }

  const translationPluralArguments = new Set(
    translationAnalysis.plurals.map(({ value }) => value),
  );
  for (const { value } of sourceAnalysis.plurals) {
    if (!translationPluralArguments.has(value)) {
      errors.push(`missing plural on ${value}`);
    }
  }

  return errors;
};

const catalogFiles = Array.fromAsync(
  new Bun.Glob("*.json").scan({
    cwd: new URL("langs", import.meta.url).pathname,
    absolute: true,
  }),
);

test("every translation preserves source arguments and complete plural forms", async () => {
  const files = await catalogFiles;
  const catalogs = new Map<string, Catalog>();
  for (const file of files) {
    catalogs.set(
      file.slice(file.lastIndexOf("/") + 1, -".json".length),
      await Bun.file(file).json(),
    );
  }

  const englishCatalog = catalogs.get("en");
  expect(englishCatalog).toBeDefined();
  if (englishCatalog === undefined) {
    return;
  }
  const englishMessages = new Map(
    flattenMessages(englishCatalog).map(({ key, value }) => [key, value]),
  );
  const failures: string[] = [];
  const analyses = new Map<string, Map<string, Analysis>>();

  for (const [locale, catalog] of catalogs) {
    const localeAnalyses = new Map<string, Analysis>();
    analyses.set(locale, localeAnalyses);
    for (const { key, value } of flattenMessages(catalog)) {
      localeAnalyses.set(key, analyzeMessage(value));
      if (locale === "en") {
        continue;
      }
      const source = englishMessages.get(key);
      expect(source, `${locale}:${key} exists in English`).toBeDefined();
      if (source === undefined) {
        continue;
      }
      for (const error of censusErrors(source, value, locale)) {
        failures.push(`${locale}:${key}: ${error}`);
      }

      const analysis = localeAnalyses.get(key);
      if (analysis === undefined) {
        continue;
      }
      const numericArguments = sorted(analysis.numericArguments).filter(
        (argument) => !analysis.dateArguments.has(argument),
      );
      if (numericArguments.length < 2) {
        continue;
      }
      if (
        EXEMPTIONS.some(
          (exemption) => exemption.locale === locale && exemption.key === key,
        )
      ) {
        continue;
      }
      const translate = createTranslator({
        locale,
        messages: { census: value },
      });
      for (const values of [
        [3, 7],
        [4, 8],
      ]) {
        const arguments_: NonNullable<Parameters<typeof translate.rich>[1]> =
          Object.fromEntries(
            sorted(analysis.arguments).map((argument) => [argument, "value"]),
          );
        for (const [index, argument] of numericArguments.entries()) {
          arguments_[argument] = values[index] ?? index + 11;
        }
        for (const argument of analysis.dateArguments) {
          arguments_[argument] = new Date("2020-01-02T00:00:00Z");
        }
        for (const tag of analysis.tags) {
          arguments_[tag] = (chunks): string => JSON.stringify(chunks);
        }
        const result = translate.rich("census", arguments_);
        const rendered =
          typeof result === "string" ? result : JSON.stringify(result);
        for (const number of values) {
          const formatted = new Intl.NumberFormat(locale).format(number);
          if (!rendered.includes(formatted)) {
            failures.push(
              `${locale}:${key}: formatted output ${JSON.stringify(rendered)} omits ${formatted}`,
            );
          }
        }
      }
    }
  }

  for (const key of englishMessages.keys()) {
    const pluralArguments = new Set<string>();
    for (const localeAnalyses of analyses.values()) {
      for (const { value } of localeAnalyses.get(key)?.plurals ?? []) {
        pluralArguments.add(value);
      }
    }
    for (const [locale, localeAnalyses] of analyses) {
      if (
        new Intl.PluralRules(locale).resolvedOptions().pluralCategories
          .length <= 1
      ) {
        continue;
      }
      const actual = new Set(
        localeAnalyses.get(key)?.plurals.map(({ value }) => value),
      );
      for (const argument of pluralArguments) {
        if (!actual.has(argument)) {
          failures.push(`${locale}:${key}: missing plural on ${argument}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});

test("census rejects argument and plural regressions", () => {
  expect(censusErrors("{count}", "done", "de")).not.toEqual([]);
  expect(
    censusErrors(
      "{count, plural, one {# item} other {# items}}",
      "{count} položek",
      "cs",
    ),
  ).not.toEqual([]);
  expect(
    censusErrors(
      "{count, plural, one {# item} other {# items}}",
      "{count, plural, one {# položka} other {# položek}}",
      "cs",
    ),
  ).not.toEqual([]);
  expect(
    censusErrors(
      "{count, plural, one {# first} other {# first}} {count, plural, one {# second} other {# second}}",
      "{count, plural, one {# první} other {# prvních}} {count, plural, one {# druhý} few {# druhé} many {# druhého} other {# druhých}}",
      "cs",
    ),
  ).not.toEqual([]);
  expect(
    censusErrors(
      "{count, plural, one {# of {total}} other {# of {total}}}",
      "{count, plural, one {# z #} few {# z #} many {# z #} other {# z #}}",
      "cs",
    ),
  ).not.toEqual([]);
});
