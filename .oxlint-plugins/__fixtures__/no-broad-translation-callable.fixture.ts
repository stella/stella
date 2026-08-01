// Passive regression fixture for
// `no-broad-translation-callable/no-broad-translation-callable`.
//
// Each disable suppresses a shape the rule MUST flag. If the rule regresses,
// the unused disable fails CI. Allowed shapes have no disable, so false
// positives fail the fixture too.

import type { useTranslations as useAliasedTranslations } from "use-intl";

type TranslationKey = "feature.title" | "feature.description";
type FeatureKey = "feature.title";
type AppKey = TranslationKey;
export type ExportedAppKey = TranslationKey;

declare const getTranslator: () => unknown;
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

// MUST flag: the full server translator type is retained in a helper alias.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type ServerTranslator = ReturnType<typeof getTranslator>;

// MUST flag: the full hook translator type is retained in a helper alias.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type HookTranslator = ReturnType<typeof useTranslations>;

// MUST flag: import aliases must not bypass the same full translator guard.
// oxlint-disable-next-line no-broad-translation-callable/no-broad-translation-callable
export type AliasedHookTranslator = ReturnType<typeof useAliasedTranslations>;

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

// Allowed: a narrow feature-specific key union keeps assignability bounded.
export type NarrowCallable = (key: FeatureKey) => string;

// Allowed: TranslationKey remains useful for validating data and return values.
export type MessageDescriptor = { key: TranslationKey };
declare const resolveMessage: () => TranslationKey;

export const fixtureValue = resolveMessage();
