import { panic } from "better-result";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  DECISION_TEXT_FIELD,
  type DecisionTextFieldKey,
} from "@stll/api-contract/case-law-text-field";
import { DECISION_DOCUMENT_ROLE_METADATA_KEY } from "@stll/api-contract/decision-document-role";

import { CITATION_SCOPE_METADATA_KEY } from "@/api/handlers/case-law/ingestion/citation-scopes";
import { READ_OUTCOME_METADATA_KEY } from "@/api/lib/errors/read-outcome";

import { STORED_DECISION_IDENTIFIERS_METADATA_KEY } from "./decision-identifier-metadata";
import { META_URL_DIAGNOSTICS } from "./metadata-urls";
import { PARTIAL_OBSERVATION_KEY } from "./partial-observation-sql";

type PipelineMetadataPolicy =
  | { type: "publisher"; replay: "preserve" }
  | { type: "derived"; replay: "replace" | "preserve" };

/** Classifies pipeline additions; adapter-owned publisher keys remain outside this registry. */
export const PIPELINE_METADATA_POLICY = {
  [DECISION_DOCUMENT_ROLE_METADATA_KEY]: { type: "derived", replay: "replace" },
  [CITATION_SCOPE_METADATA_KEY]: { type: "derived", replay: "replace" },
  [DECISION_TEXT_ABSENCE_METADATA_KEY]: { type: "derived", replay: "replace" },
  [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]: {
    type: "derived",
    replay: "replace",
  },
  [META_URL_DIAGNOSTICS]: { type: "derived", replay: "replace" },
  // A local parse cannot re-observe a publisher response or its read refusal.
  [PARTIAL_OBSERVATION_KEY]: { type: "derived", replay: "preserve" },
  [READ_OUTCOME_METADATA_KEY]: { type: "derived", replay: "preserve" },
  [STORED_DECISION_IDENTIFIERS_METADATA_KEY]: {
    type: "publisher",
    replay: "preserve",
  },
  [DECISION_TEXT_FIELD.ABSTRACT]: { type: "publisher", replay: "preserve" },
  [DECISION_TEXT_FIELD.HEADNOTE]: { type: "publisher", replay: "preserve" },
  [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: {
    type: "publisher",
    replay: "preserve",
  },
  [DECISION_TEXT_FIELD.SUMMARY]: { type: "publisher", replay: "preserve" },
} as const satisfies Record<DecisionTextFieldKey, PipelineMetadataPolicy> &
  Record<string, PipelineMetadataPolicy>;

type PipelineMetadataKey = keyof typeof PIPELINE_METADATA_POLICY;
export type DerivedReplayMetadataKey = {
  [Key in PipelineMetadataKey]: (typeof PIPELINE_METADATA_POLICY)[Key] extends {
    type: "derived";
    replay: "replace";
  }
    ? Key
    : never;
}[PipelineMetadataKey];
export type DerivedReplayMetadataPatch = Partial<
  Record<DerivedReplayMetadataKey, unknown>
>;

const isPipelineMetadataKey = (key: string): key is PipelineMetadataKey =>
  Object.hasOwn(PIPELINE_METADATA_POLICY, key);

const isDerivedReplayMetadataKey = (
  key: string,
): key is DerivedReplayMetadataKey =>
  isPipelineMetadataKey(key) &&
  PIPELINE_METADATA_POLICY[key].type === "derived" &&
  PIPELINE_METADATA_POLICY[key].replay === "replace";
export const DERIVED_REPLAY_METADATA_KEYS = Object.keys(
  PIPELINE_METADATA_POLICY,
).filter(isDerivedReplayMetadataKey);

/** A pipeline key without a reviewed disposition is a programmer error. */
export const pipelineMetadataPolicy = (key: string): PipelineMetadataPolicy => {
  if (!isPipelineMetadataKey(key)) {
    return panic(`Unclassified pipeline metadata key: ${key}`);
  }
  return PIPELINE_METADATA_POLICY[key];
};
