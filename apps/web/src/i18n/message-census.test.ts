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
const EXEMPTIONS: readonly Exemption[] = [
  {
    check: "formatting",
    key: "inspector.review.flaggedPositions",
    locale: "ar",
    reason:
      "The zero-total branch naturally omits the necessarily zero flagged count.",
  },
  {
    check: "formatting",
    key: "inspector.review.progressPositions",
    locale: "ar",
    reason:
      "The zero-total branch naturally omits the necessarily zero completed count.",
  },
  {
    check: "formatting",
    key: "inspector.review.flaggedPositions",
    locale: "lv",
    reason:
      "The zero-total branch naturally omits the necessarily zero flagged count.",
  },
  {
    check: "formatting",
    key: "inspector.review.progressPositions",
    locale: "lv",
    reason:
      "The zero-total branch naturally omits the necessarily zero completed count.",
  },
];

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
  argumentTypes: Map<string, Set<ArgumentType>>;
  numericArguments: Set<string>;
  dateArguments: Set<string>;
  plurals: PluralElement[];
  tags: Set<string>;
};

type ArgumentType = "numeric" | "date" | "string";

const addArgumentType = (
  argumentTypes: Map<string, Set<ArgumentType>>,
  argument: string,
  type: ArgumentType,
) => {
  const types = argumentTypes.get(argument) ?? new Set<ArgumentType>();
  types.add(type);
  argumentTypes.set(argument, types);
};

export const analyzeMessage = (message: string): Analysis => {
  const analysis: Analysis = {
    arguments: new Set(),
    argumentTypes: new Map(),
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
        addArgumentType(analysis.argumentTypes, element.value, "numeric");
      } else if (isNumberElement(element)) {
        analysis.numericArguments.add(element.value);
        addArgumentType(analysis.argumentTypes, element.value, "numeric");
      } else if (isSelectElement(element)) {
        addArgumentType(analysis.argumentTypes, element.value, "string");
      } else if (isPluralElement(element)) {
        addArgumentType(analysis.argumentTypes, element.value, "numeric");
      }
      if (isDateElement(element) || isTimeElement(element)) {
        analysis.dateArguments.add(element.value);
        addArgumentType(analysis.argumentTypes, element.value, "date");
      }
      if (isTagElement(element)) {
        analysis.tags.add(element.value);
        visit(element.children, pluralStack);
      } else if (isSelectElement(element)) {
        for (const option of Object.values(element.options)) {
          visit(option.value, pluralStack);
        }
      } else if (isPluralElement(element)) {
        analysis.numericArguments.add(element.value);
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

  for (const argument of sourceAnalysis.arguments) {
    const sourceTypes = sorted(
      sourceAnalysis.argumentTypes.get(argument) ?? [],
    );
    const translationTypes = sorted(
      translationAnalysis.argumentTypes.get(argument) ?? [],
    );
    if (JSON.stringify(sourceTypes) !== JSON.stringify(translationTypes)) {
      errors.push(
        `argument ${argument} types: expected ${sourceTypes.join(", ")}; received ${translationTypes.join(", ")}`,
      );
    }
  }

  for (const [index, plural] of translationAnalysis.plurals.entries()) {
    const categories = new Intl.PluralRules(locale, {
      type: plural.pluralType,
    }).resolvedOptions().pluralCategories;
    if (categories.length > 1) {
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

  return errors;
};

const PLURAL_CANDIDATES = [
  0, 1, 2, 3, 4, 5, 6, 11, 12, 21, 22, 101, 1_000_000, 1_000_001, 1.5,
] as const;

type PluralRepresentatives = {
  missing: Intl.LDMLPluralRule[];
  values: Map<Intl.LDMLPluralRule, number>;
};

const pluralRepresentatives = (
  locale: string,
  type: Intl.PluralRuleType,
): PluralRepresentatives => {
  const rules = new Intl.PluralRules(locale, { type });
  const categories = rules.resolvedOptions().pluralCategories;
  const representatives = new Map<Intl.LDMLPluralRule, number>();
  for (const value of PLURAL_CANDIDATES) {
    const category = rules.select(value);
    if (!representatives.has(category)) {
      representatives.set(category, value);
    }
  }
  return {
    missing: categories.filter((category) => !representatives.has(category)),
    values: representatives,
  };
};

const render = (
  message: string,
  locale: string,
  analysis: Analysis,
  numericArguments: string[],
  controllingArgument: string,
  controllingValue: number,
) => {
  const arguments_: NonNullable<
    Parameters<ReturnType<typeof createTranslator>["rich"]>[1]
  > = Object.fromEntries(
    sorted(analysis.arguments).map((argument) => [argument, "value"]),
  );
  const usedValues = new Set([controllingValue]);
  let candidate = 5;
  for (const argument of numericArguments) {
    if (argument === controllingArgument) {
      arguments_[argument] = controllingValue;
      continue;
    }
    while (usedValues.has(candidate)) {
      candidate += 1;
    }
    arguments_[argument] = candidate;
    usedValues.add(candidate);
    candidate += 1;
  }
  for (const argument of analysis.dateArguments) {
    arguments_[argument] = new Date("2020-01-02T00:00:00Z");
  }
  for (const tag of analysis.tags) {
    arguments_[tag] = (chunks): string => JSON.stringify(chunks);
  }
  const result = createTranslator({
    locale,
    messages: { census: message },
  }).rich("census", arguments_);
  return {
    arguments_,
    rendered: typeof result === "string" ? result : JSON.stringify(result),
  };
};

export const renderingErrors = (
  source: string,
  translation: string,
  locale: string,
): string[] => {
  const sourceAnalysis = analyzeMessage(source);
  const translationAnalysis = analyzeMessage(translation);
  const numericArguments = sorted(
    new Set([
      ...sourceAnalysis.numericArguments,
      ...translationAnalysis.numericArguments,
    ]),
  ).filter(
    (argument) =>
      !sourceAnalysis.dateArguments.has(argument) &&
      !translationAnalysis.dateArguments.has(argument),
  );
  const controllingArguments = new Set([
    ...sourceAnalysis.plurals.map(({ value }) => value),
    ...translationAnalysis.plurals.map(({ value }) => value),
  ]);
  const errors: string[] = [];
  for (const controllingArgument of controllingArguments) {
    const pluralTypes = new Set(
      [...sourceAnalysis.plurals, ...translationAnalysis.plurals]
        .filter(({ value }) => value === controllingArgument)
        .map(({ pluralType }) => pluralType ?? "cardinal"),
    );
    for (const pluralType of pluralTypes) {
      const representatives = pluralRepresentatives(locale, pluralType);
      if (representatives.missing.length > 0) {
        const ruleType = pluralType === "ordinal" ? "ordinal" : "cardinal";
        errors.push(
          `${ruleType} plural representatives are missing ${representatives.missing.join(", ")}`,
        );
      }
      for (const [category, value] of representatives.values) {
        const sourceResult = render(
          source,
          locale,
          sourceAnalysis,
          numericArguments,
          controllingArgument,
          value,
        );
        const translationResult = render(
          translation,
          locale,
          translationAnalysis,
          numericArguments,
          controllingArgument,
          value,
        );
        for (const argument of numericArguments) {
          if (argument === controllingArgument) {
            continue;
          }
          const argumentValue = sourceResult.arguments_[argument];
          if (typeof argumentValue !== "number") {
            continue;
          }
          const formatted = new Intl.NumberFormat(locale).format(argumentValue);
          if (
            sourceResult.rendered.includes(formatted) &&
            !translationResult.rendered.includes(formatted)
          ) {
            errors.push(
              `${controllingArgument}=${value} (${category}) renders ${JSON.stringify(translationResult.rendered)} without ${argument}=${formatted}`,
            );
          }
        }
      }
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

  for (const [locale, catalog] of catalogs) {
    for (const { key, value } of flattenMessages(catalog)) {
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
      if (
        !EXEMPTIONS.some(
          (exemption) => exemption.locale === locale && exemption.key === key,
        )
      ) {
        for (const error of renderingErrors(source, value, locale)) {
          failures.push(`${locale}:${key}: ${error}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});

test("census rejects argument and plural regressions", () => {
  expect(censusErrors("{count}", "done", "de")).not.toEqual([]);
  expect(censusErrors("{count, number}", "{count, date}", "en")).not.toEqual(
    [],
  );
  expect(
    censusErrors(
      "{count, number}",
      "{count, plural, one {# item} other {# items}}",
      "en",
    ),
  ).toEqual([]);
  expect(
    censusErrors(
      "{count, plural, one {# item} other {# items}}",
      "{count} položek",
      "cs",
    ),
  ).toEqual([]);
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
  expect(
    renderingErrors(
      "{count, plural, one {# of {total}} other {# of {total}}}",
      "{count, plural, one {# of #} other {# of {total}}}",
      "en",
    ),
  ).toEqual(['count=1 (one) renders "1 of 1" without total=5']);
  expect(
    renderingErrors(
      "{count, plural, one {# of {total}} other {# of {total}}}",
      "{count, plural, one {# sur {total}} many {# sur #} other {# sur {total}}}",
      "fr",
    ),
  ).toEqual([
    'count=1000000 (many) renders "1\u202f000\u202f000 sur 1\u202f000\u202f000" without total=5',
  ]);
});
