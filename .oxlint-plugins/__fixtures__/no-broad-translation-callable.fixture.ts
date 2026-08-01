// Passive regression fixture for
// `no-broad-translation-callable/no-broad-translation-callable`.
//
// Each disable suppresses a shape the rule MUST flag. If the rule regresses,
// the unused disable fails CI. Allowed shapes have no disable, so false
// positives fail the fixture too.

import type * as intl from "use-intl";
import type { useTranslations as useAliasedTranslations } from "use-intl";

import type * as landingI18n from "../../apps/landing/src/i18n/utils";
import type { getTranslations as getAliasedTranslations } from "../../apps/landing/src/i18n/utils";
import type * as i18n from "../../apps/web/src/i18n/types";
import type { TranslationKey as ImportedTranslationKey } from "../../apps/web/src/i18n/types";

// MUST flag: renaming TranslationKey during a direct re-export would let a
// consumer import the broad key union under an unrecognizable name.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type { TranslationKey as ReexportedCatalogKey } from "../../apps/web/src/i18n/types";

type TranslationKey = "feature.title" | "feature.description";
type FeatureKey = "feature.title";
type AppKey = TranslationKey;
// MUST flag: exported aliases of the broad union are forbidden at the module
// boundary, before another module can import the hidden name.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type ExportedAppKey = TranslationKey;

declare const getTranslator: () => unknown;
declare const getTranslations: () => unknown;
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- The generic namespace syntax is the allowed use-intl shape under test.
declare const useTranslations: <Namespace extends string>() => {
  namespace: Namespace;
};

// MUST flag: a helper callable claims to accept the entire application key
// union, forcing TypeScript to compare the full overloaded translator.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type BroadCallable = (key: TranslationKey) => string;

// MUST flag: renaming the full key union must not bypass the invariant.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type AliasedBroadCallable = (key: AppKey) => string;

// MUST flag: exported aliases retain the same broad key set.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type ExportedAliasedBroadCallable = (key: ExportedAppKey) => string;

// MUST flag: a namespace import of the app catalog cannot hide the broad key
// union.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type QualifiedBroadCallable = (key: i18n.TranslationKey) => string;

// MUST flag: renamed imports of the canonical TranslationKey binding remain
// broad even though the local identifier differs.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type ImportedBroadCallable = (key: ImportedTranslationKey) => string;

// MUST flag: the full server translator type is retained in a helper alias.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type ServerTranslator = ReturnType<typeof getTranslator>;

// MUST flag: the full hook translator type is retained in a helper alias.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type HookTranslator = ReturnType<typeof useTranslations>;

// MUST flag: import aliases must not bypass the same full translator guard.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type AliasedHookTranslator = ReturnType<typeof useAliasedTranslations>;

// MUST flag: a namespace import of use-intl retains the full hook translator.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type NamespacedHookTranslator = ReturnType<typeof intl.useTranslations>;

// MUST flag: landing's full-catalog factory has the same broad callable shape.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type LandingTranslator = ReturnType<typeof getTranslations>;

// MUST flag: a renamed import cannot hide landing's translator factory.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type AliasedLandingTranslator = ReturnType<
  typeof getAliasedTranslations
>;

// MUST flag: a namespace import cannot hide landing's translator factory.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type NamespacedLandingTranslator = ReturnType<
  typeof landingI18n.getTranslations
>;

// Allowed: a namespace argument bounds the translator to one feature subtree.
export type NamespacedTranslator = ReturnType<
  typeof useTranslations<"feature">
>;

// MUST flag: call signatures are another spelling of the broad callable.
export type BroadCallSignature = {
  // oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable, typescript/prefer-function-type -- The call-signature spelling is the syntax under test.
  (key: TranslationKey): string;
};

// MUST flag: method signatures are another spelling of the broad callable.
export type BroadMethodSignature = {
  // oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable, typescript/method-signature-style -- The method-signature spelling is the syntax under test.
  translate(key: TranslationKey): string;
};

// MUST flag: aliases declared inside a local scope are part of the same broad
// key graph, including forward references and multi-step chains.
export const nestedAliasFixture = () => {
  type FirstNestedKey = SecondNestedKey;
  type SecondNestedKey = ThirdNestedKey;
  type ThirdNestedKey = TranslationKey;
  // oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
  type NestedBroadCallable = (key: FirstNestedKey) => string;

  return (translator: NestedBroadCallable) => translator;
};

// MUST flag only the broad binding when separate lexical scopes reuse the
// same alias name; the narrow binding below must remain allowed.
export const broadScopedAliasFixture = () => {
  type ReusedKey = TranslationKey;
  // oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
  type ScopedBroadCallable = (key: ReusedKey) => string;

  return (translator: ScopedBroadCallable) => translator;
};

export const narrowScopedAliasFixture = () => {
  type ReusedKey = FeatureKey;
  type ScopedNarrowCallable = (key: ReusedKey) => string;

  return (translator: ScopedNarrowCallable) => translator;
};

// Allowed: a narrow feature-specific key union keeps assignability bounded.
export type NarrowCallable = (key: FeatureKey) => string;

// Allowed: TranslationKey remains useful for validating data and return values.
export type MessageDescriptor = { key: TranslationKey };
declare const resolveMessage: () => TranslationKey;

export const fixtureValue = resolveMessage();
