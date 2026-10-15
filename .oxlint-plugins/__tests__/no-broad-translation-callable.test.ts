import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects broad callable key aliases", async () => {
  expect(
    await lintSingleRule(
      "no-broad-translation-callable",
      `import type {TranslationKey as Key} from "@/lib/i18n/types";
type Translator = (key: Key) => string;`,
    ),
  ).toEqual([2]);
});

test("rejects unscoped hook return types", async () => {
  expect(
    await lintSingleRule(
      "no-broad-translation-callable",
      `import {useTranslations} from "@/lib/i18n/utils";
type Translator = ReturnType<typeof useTranslations>;`,
    ),
  ).toEqual([2]);
});

test("allows a finite feature vocabulary", async () => {
  expect(
    await lintSingleRule(
      "no-broad-translation-callable",
      `type LabelKey = "save" | "cancel";
type LabelTranslator = (key:LabelKey) => string;`,
    ),
  ).toEqual([]);
});

test("allows translated values and key data", async () => {
  expect(
    await lintSingleRule(
      "no-broad-translation-callable",
      `import type {TranslationKey} from "@/lib/i18n/types";
const labels: Record<string, TranslationKey> = {};
const format = (label:string) => label.trim();`,
    ),
  ).toEqual([]);
});
