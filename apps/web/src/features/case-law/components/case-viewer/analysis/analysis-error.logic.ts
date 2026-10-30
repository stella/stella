import { panic } from "better-result";

import type {
  CaseLawAnalysisFailureCode as AnalysisFailureCode,
  CaseLawAnalysisUnavailableCode,
} from "@stll/api-contract";

import {
  PROVIDER_KEYS,
  PROVIDER_LABELS,
} from "@/components/ai-config-role-models.logic";
import type {
  AnalysisError,
  AnalysisFailureKey,
} from "@/features/case-law/queries/decision-analysis";
import type { TranslationKey } from "@/i18n/types";

/**
 * The failure messages that name whose key the run used. Each one is an ICU
 * `select` on `source`, so an organization's own key and the platform's read
 * as different sentences rather than one sentence with a fragment swapped in.
 */
export const ANALYSIS_KEYED_FAILURE_MESSAGE = {
  answer_incomplete: "caseLaw.analysis.errors.answerIncomplete",
  timed_out: "caseLaw.analysis.errors.timedOut",
  provider_refused: "caseLaw.analysis.errors.providerRefused",
  provider_unavailable: "caseLaw.analysis.errors.providerUnavailable",
} as const satisfies Record<
  Exclude<AnalysisFailureCode, "failed">,
  TranslationKey
>;

const ANALYSIS_UNAVAILABLE_MESSAGE = {
  decision_not_found: "caseLaw.analysis.errors.decisionNotFound",
  document_unparseable: "caseLaw.analysis.errors.documentUnparseable",
  language_unsupported: "caseLaw.analysis.errors.languageUnsupported",
  analysis_disabled: "caseLaw.analysis.errors.analysisDisabled",
  source_restricted: "caseLaw.analysis.errors.sourceRestricted",
} as const satisfies Record<CaseLawAnalysisUnavailableCode, TranslationKey>;

type KeyedFailureCode = keyof typeof ANALYSIS_KEYED_FAILURE_MESSAGE;

/** What the reader is told about an analysis that is not there. */
export type AnalysisErrorMessage =
  | {
      kind: "keyed";
      key: (typeof ANALYSIS_KEYED_FAILURE_MESSAGE)[KeyedFailureCode];
      values: { source: AnalysisFailureKey["source"]; provider: string };
    }
  | { kind: "generic" }
  | {
      kind: "unavailable";
      key: (typeof ANALYSIS_UNAVAILABLE_MESSAGE)[CaseLawAnalysisUnavailableCode];
    };

const isProviderKey = (
  provider: string,
): provider is (typeof PROVIDER_KEYS)[number] =>
  PROVIDER_KEYS.some((known) => known === provider);

/** The provider as the reader knows it from organization settings. */
export const providerLabel = (provider: string): string =>
  isProviderKey(provider) ? PROVIDER_LABELS[provider] : provider;

const keyedMessage = (
  code: KeyedFailureCode,
  key: AnalysisFailureKey,
): AnalysisErrorMessage => ({
  kind: "keyed",
  key: ANALYSIS_KEYED_FAILURE_MESSAGE[code],
  values:
    key.source === "organization"
      ? { source: "organization", provider: providerLabel(key.provider) }
      : { source: "platform", provider: "" },
});

/**
 * The time a failed run's provider asked not to be retried before, if it
 * named one. The server refuses a new run until then regardless, so the
 * reader is told when instead of being offered a retry that cannot help.
 */
export const analysisRetryAt = (error: AnalysisError): Date | undefined =>
  error.kind === "failed" ? error.retryAt : undefined;

export const analysisErrorMessage = (
  error: AnalysisError,
): AnalysisErrorMessage => {
  switch (error.kind) {
    case "unavailable":
      return {
        kind: "unavailable",
        key: ANALYSIS_UNAVAILABLE_MESSAGE[error.code],
      };
    case "unreadable":
      return { kind: "generic" };
    case "failed": {
      const { code } = error;
      switch (code) {
        case "failed":
          return { kind: "generic" };
        case "answer_incomplete":
        case "timed_out":
        case "provider_refused":
        case "provider_unavailable":
          return keyedMessage(code, error.key);
        default:
          code satisfies never;
          return panic("Unhandled analysis failure code");
      }
    }
    default:
      error satisfies never;
      return panic("Unhandled analysis error");
  }
};
