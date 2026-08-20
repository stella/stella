import type { OfferedBYOKModelId, ReasoningEffort } from "./index";

/**
 * Hand-declared capabilities for offered models that models.dev does
 * not cover. The capability generator
 * (`packages/scripts/src/model-catalog-capabilities-gen.ts`) refuses
 * an override for any model the upstream source covers, so manual
 * data cannot shadow sourced data — this file can only ever fill
 * genuine gaps, each with a dated justification.
 */
export type CapabilityOverride = {
  documentInput: boolean;
  documentInputReason: string;
  reasoningEfforts: readonly ReasoningEffort[] | null;
  temperatureSupported: boolean;
  /** Why the upstream source cannot answer for this model. Dated. */
  reason: string;
};

export const CAPABILITY_OVERRIDES: Partial<
  Record<OfferedBYOKModelId, CapabilityOverride>
> = {
  "us.amazon.nova-pro-v1:0": {
    documentInput: true,
    documentInputReason:
      "2026-08-20: AWS documents PDF input for Nova Pro through Bedrock Converse",
    reasoningEfforts: null,
    temperatureSupported: true,
    reason:
      "2026-07-20: absent from the models.dev amazon-bedrock catalog; " +
      "Bedrock Converse accepts temperature and Nova has no reasoning dial",
  },
  "us.amazon.nova-lite-v1:0": {
    documentInput: true,
    documentInputReason:
      "2026-08-20: AWS documents PDF input for Nova Lite through Bedrock Converse",
    reasoningEfforts: null,
    temperatureSupported: true,
    reason:
      "2026-07-20: absent from the models.dev amazon-bedrock catalog; " +
      "Bedrock Converse accepts temperature and Nova has no reasoning dial",
  },
  "us.amazon.nova-micro-v1:0": {
    documentInput: false,
    documentInputReason: "2026-08-20: AWS documents Nova Micro as text-only",
    reasoningEfforts: null,
    temperatureSupported: true,
    reason:
      "2026-07-20: absent from the models.dev amazon-bedrock catalog; " +
      "Bedrock Converse accepts temperature and Nova has no reasoning dial",
  },
};
