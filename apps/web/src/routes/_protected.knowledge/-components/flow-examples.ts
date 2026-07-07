import type { useTranslations } from "use-intl";

import type { FlowStep } from "@/routes/_protected.knowledge/-components/flow-types";

// Client-side starter presets shown as "start from an example" cards on the
// empty workflows list. Each preset is a function of the translator so the
// prefilled draft (name, description, step prompts) lands in the viewer's
// language instead of being hardcoded to English.

export const FLOW_EXAMPLE_KEYS = [
  "nda-intake",
  "due-diligence",
  "document-summary",
] as const;
export type FlowExampleKey = (typeof FLOW_EXAMPLE_KEYS)[number];

export type FlowExample = {
  name: string;
  description: string;
  steps: FlowStep[];
};

type Translate = ReturnType<typeof useTranslations>;

const ndaIntakeExample = (t: Translate): FlowExample => ({
  name: t("flows.examples.ndaIntake.name"),
  description: t("flows.examples.ndaIntake.description"),
  steps: [
    {
      kind: "ai",
      name: t("flows.examples.ndaIntake.reviewStepName"),
      prompt: t("flows.examples.ndaIntake.reviewStepPrompt"),
      includeDocuments: true,
    },
    {
      kind: "review-gate",
      name: t("flows.examples.ndaIntake.reviewGateStepName"),
      instructions: t("flows.examples.ndaIntake.reviewGateInstructions"),
    },
    {
      kind: "create-document",
      name: t("flows.examples.ndaIntake.createStepName"),
      documentTitle: t("flows.examples.ndaIntake.documentTitle"),
    },
  ],
});

const dueDiligenceExample = (t: Translate): FlowExample => ({
  name: t("flows.examples.dueDiligence.name"),
  description: t("flows.examples.dueDiligence.description"),
  steps: [
    {
      kind: "ai",
      name: t("flows.examples.dueDiligence.reviewStepName"),
      prompt: t("flows.examples.dueDiligence.reviewStepPrompt"),
      includeDocuments: true,
    },
    {
      kind: "review-gate",
      name: t("flows.examples.dueDiligence.reviewGateStepName"),
      instructions: t("flows.examples.dueDiligence.reviewGateInstructions"),
    },
    {
      kind: "create-document",
      name: t("flows.examples.dueDiligence.createStepName"),
      documentTitle: t("flows.examples.dueDiligence.documentTitle"),
    },
  ],
});

const documentSummaryExample = (t: Translate): FlowExample => ({
  name: t("flows.examples.documentSummary.name"),
  description: t("flows.examples.documentSummary.description"),
  steps: [
    {
      kind: "ai",
      name: t("flows.examples.documentSummary.summaryStepName"),
      prompt: t("flows.examples.documentSummary.summaryStepPrompt"),
      includeDocuments: true,
    },
    {
      kind: "create-document",
      name: t("flows.examples.documentSummary.createStepName"),
      documentTitle: t("flows.examples.documentSummary.documentTitle"),
    },
  ],
});

const FLOW_EXAMPLE_BUILDERS = {
  "nda-intake": ndaIntakeExample,
  "due-diligence": dueDiligenceExample,
  "document-summary": documentSummaryExample,
} as const satisfies Record<FlowExampleKey, (t: Translate) => FlowExample>;

export const buildFlowExample = (
  key: FlowExampleKey,
  t: Translate,
): FlowExample => FLOW_EXAMPLE_BUILDERS[key](t);
