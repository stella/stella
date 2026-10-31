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
  type SelectElement,
  TYPE,
} from "@formatjs/icu-messageformat-parser";
import { expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

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
  ast: MessageFormatElement[];
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

const analyzeMessage = (message: string): Analysis => {
  const analysis: Analysis = {
    arguments: new Set(),
    argumentTypes: new Map(),
    numericArguments: new Set(),
    dateArguments: new Set(),
    plurals: [],
    ast: parse(message, { captureLocation: true }),
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

  visit(analysis.ast, []);
  for (const argument of plainArguments) {
    analysis.numericArguments.add(argument);
  }
  return analysis;
};

const sorted = (values: Iterable<string>) => [...values].toSorted();

const censusErrors = (
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

type BranchValue = number | string;
type BranchScenario = { label: string; values: Map<string, BranchValue> };

const pluralCandidates = function* () {
  for (let value = 0; value <= 2000; value += 1) {
    yield value;
  }
  for (let value = 0; value <= 200; value += 1) {
    yield value + 0.1;
    yield value + 0.01;
  }
  yield 1_000_000;
  yield 1_000_001;
};

const selectedPluralOption = (
  plural: PluralElement,
  rules: Intl.PluralRules,
  value: number,
) => {
  const explicit = `=${value}`;
  if (explicit in plural.options) {
    return explicit;
  }
  const category = rules.select(value - plural.offset);
  return category in plural.options ? category : "other";
};

const valueForPluralOption = (
  plural: PluralElement,
  option: string,
  locale: string,
) => {
  if (option.startsWith("=")) {
    return Number(option.slice(1));
  }
  const rules = new Intl.PluralRules(locale, { type: plural.pluralType });
  for (const value of pluralCandidates()) {
    if (selectedPluralOption(plural, rules, value) === option) {
      return value;
    }
  }
  return undefined;
};

const selectedSelectOption = (select: SelectElement, value: string) =>
  value in select.options ? value : "other";

const branchScenarios = (analysis: Analysis, locale: string) => {
  const scenarios: BranchScenario[] = [];
  const visit = (
    elements: MessageFormatElement[],
    inherited: Map<string, BranchValue>,
  ) => {
    for (const element of elements) {
      if (isTagElement(element)) {
        visit(element.children, inherited);
        continue;
      }
      if (!isPluralElement(element) && !isSelectElement(element)) {
        continue;
      }

      for (const [option, { value: children }] of Object.entries(
        element.options,
      )) {
        let branchValue: BranchValue | undefined;
        if (isPluralElement(element)) {
          branchValue = valueForPluralOption(element, option, locale);
        } else {
          branchValue =
            option === "other" ? `__census_other_${element.value}__` : option;
        }
        if (branchValue === undefined) {
          continue;
        }
        const existing = inherited.get(element.value);
        if (
          existing !== undefined &&
          (isPluralElement(element)
            ? selectedPluralOption(
                element,
                new Intl.PluralRules(locale, { type: element.pluralType }),
                Number(existing),
              ) !== option
            : selectedSelectOption(element, String(existing)) !== option)
        ) {
          continue;
        }
        const values = new Map(inherited);
        values.set(element.value, existing ?? branchValue);
        scenarios.push({
          label: `${element.value}=${String(values.get(element.value))} (${option})`,
          values,
        });
        visit(children, values);
      }
    }
  };
  visit(analysis.ast, new Map());
  return scenarios;
};

const render = (
  message: string,
  locale: string,
  analysis: Analysis,
  numericArguments: string[],
  branchValues: Map<string, BranchValue>,
) => {
  const arguments_: NonNullable<
    Parameters<ReturnType<typeof createTranslator>["rich"]>[1]
  > = Object.fromEntries(
    sorted(analysis.arguments).map((argument) => [argument, "value"]),
  );
  const usedValues = new Set(branchValues.values());
  for (const [argument, value] of branchValues) {
    arguments_[argument] = value;
  }
  let candidate = 5;
  for (const argument of numericArguments) {
    if (branchValues.has(argument)) {
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

const renderingErrors = (
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
  const errors: string[] = [];
  const scenarios = [
    ...branchScenarios(sourceAnalysis, locale),
    ...branchScenarios(translationAnalysis, locale),
  ].filter(
    (scenario, index, all) =>
      all.findIndex(
        ({ values }) =>
          JSON.stringify([...values.entries()]) ===
          JSON.stringify([...scenario.values.entries()]),
      ) === index,
  );
  for (const scenario of scenarios) {
    const sourceResult = render(
      source,
      locale,
      sourceAnalysis,
      numericArguments,
      scenario.values,
    );
    const translationResult = render(
      translation,
      locale,
      translationAnalysis,
      numericArguments,
      scenario.values,
    );
    for (const argument of numericArguments) {
      if (scenario.values.has(argument)) {
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
          `${scenario.label} renders ${JSON.stringify(translationResult.rendered)} without ${argument}=${formatted}`,
        );
      }
    }
  }
  return errors;
};

const catalogFiles = sourceFileIndex(
  new URL("langs", import.meta.url).pathname,
  {
    pattern: "*.json",
  },
);

test("every translation preserves source arguments and complete plural forms", () => {
  const catalogs = new Map<string, Catalog>();
  for (const { relativePath, sourceText } of catalogFiles) {
    catalogs.set(
      relativePath.slice(0, -".json".length),
      JSON.parse(sourceText),
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
  expect(
    renderingErrors(
      "{count, plural, offset:1 =42 {# of {total}} other {# of {total}}}",
      "{count, plural, offset:1 =42 {# of #} other {# of {total}}}",
      "en",
    ),
  ).toContain('count=42 (=42) renders "41 of 41" without total=5');
  expect(
    renderingErrors(
      "{kind, select, exact {{count} of {total}} other {{count} of {total}}}",
      "{kind, select, exact {{count} total} other {{count} of {total}}}",
      "en",
    ),
  ).toContain('kind=exact (exact) renders "5 total" without total=6');
  expect(
    renderingErrors(
      "{place, selectordinal, one {#st of {total}} two {#nd of {total}} few {#rd of {total}} other {#th of {total}}}",
      "{place, selectordinal, one {#st of {total}} two {#nd of #} few {#rd of {total}} other {#th of {total}}}",
      "en",
    ),
  ).toContain('place=2 (two) renders "2nd of 2" without total=5');
});
